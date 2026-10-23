import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FiberMap, Scope } from "effect";
import { NativeEnvelope, NativeStep } from "../src/native-envelope.js";
import { admitSend, makeSupervisionGate, type AdmittedInFlight, type GateGuard, type SendPreparation } from "../src/supervision-gate.js";
import { envelopePeer } from "./support/envelope-peer.js";
import { dataDirectory, withGuidanceDb } from "./support/g9-stores.js";

// CT-LIN-05, the executable admission contract (plan 3.11), against a fake transport whose initiate is a synchronous
// handoff (an optional step after it lets a test deliver an interruption or a transport shutdown inside the section) and
// whose reply waits on a Deferred; Stop is a section that commits the policy and then the bookkeeping. The gate runs on the
// guidance client of a temporary guidance.sqlite3 (its production layer), whose open transaction it never admits from

// `test` with the guidance client of a fresh data directory as the run's GuidanceDb
const onGuidanceFile = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.flatMap(dataDirectory("supervision-gate-"), (directory) => withGuidanceDb(directory, () => test));

// guard predicates that read the given stop flag when they run
const flagGuard = (stopped: () => boolean): GateGuard => ({
  scopeEnabled: () => Effect.sync(() => !stopped()),
  supervisionStopped: () => Effect.sync(() => stopped()),
  workflowEditingEnabled: () => Effect.sync(() => !stopped()),
});

type Outcome = { readonly _tag: "sent"; readonly reply: string } | { readonly _tag: "denied" } | { readonly _tag: "reconcile"; readonly state: string };

const harness = Effect.gen(function* () {
  const log: string[] = [];
  const receipts = new Map<string, "admitted" | "sent" | "uncertain">();
  const replies = new Map<string, Deferred.Deferred<string>>();
  const releases = new Map<string, number>();
  let stopped = false;
  const gate = yield* makeSupervisionGate(flagGuard(() => stopped));
  const transportScope = yield* Scope.make();
  const inFlight = yield* FiberMap.make<string, Outcome>().pipe(Scope.provide(transportScope));

  const initiate = (id: string, during?: Effect.Effect<void>) => Effect.gen(function* () {
    log.push(`initiate:${id}`);
    const reply = yield* Deferred.make<string>();
    replies.set(id, reply);
    let released = false;
    const release = Effect.sync(() => {
      if (released) return;
      released = true;
      releases.set(id, (releases.get(id) ?? 0) + 1);
      log.push(`release:${id}`);
    });
    if (during) yield* during;
    const result = Deferred.await(reply).pipe(
      Effect.map((value): Outcome => { receipts.set(id, "sent"); return { _tag: "sent", reply: value }; }),
      Effect.onInterrupt(() => Effect.sync(() => { if (receipts.get(id) === "admitted") receipts.set(id, "uncertain"); })),
    );
    return { result, release } satisfies AdmittedInFlight<Outcome>;
  });

  const fromReceipt = (id: string): Outcome => ({ _tag: "reconcile", state: receipts.get(id) ?? "none" });
  const send = (id: string, during?: Effect.Effect<void>) => admitSend(gate, {
    identity: id,
    inFlight,
    prepare: (current) => Effect.gen(function* () {
      if (receipts.has(id)) return { _tag: "Answer" as const, value: fromReceipt(id) };
      if (yield* current.supervisionStopped("main-chat")) return { _tag: "Answer" as const, value: { _tag: "denied" } as Outcome };
      receipts.set(id, "admitted");
      log.push(`receipt:${id}`);
      return { _tag: "Initiate" as const, initiate: initiate(id, during) };
    }),
    reconcile: Effect.sync(() => fromReceipt(id)),
  });
  const stop = (barrier?: Deferred.Deferred<void>) => gate.admit(() => Effect.gen(function* () {
    stopped = true;
    log.push("policy-commit");
    if (barrier) yield* Deferred.await(barrier);
    log.push("bookkeeping");
  }));
  // a section that holds the permit until released, entered once it runs
  const hold = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
    gate.admit(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
  const reply = (id: string, value: string) => Deferred.succeed(replies.get(id)!, value);
  const until = (condition: () => boolean) => Effect.gen(function* () { while (!condition()) yield* Effect.yieldNow; });
  const initiates = () => log.filter((entry) => entry.startsWith("initiate")).length;
  return { log, receipts, releases, send, stop, hold, reply, until, initiates, transportScope };
});

describe("CT-LIN-05 admission section", () => {
  it.effect("1: a Stop completes while an admitted send awaits its reply; the send keeps its identity and a duplicate initiates nothing", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const first = yield* Effect.forkChild(h.send("m1"));
      yield* h.until(() => h.log.includes("initiate:m1"));
      yield* Fiber.join(yield* Effect.forkChild(h.stop()));
      assert.deepEqual(h.log, ["receipt:m1", "initiate:m1", "policy-commit", "bookkeeping"]);
      const duplicate = yield* Effect.forkChild(h.send("m1"));
      yield* Effect.yieldNow;
      yield* h.reply("m1", "ok");
      assert.deepEqual(yield* Fiber.join(first), { _tag: "sent", reply: "ok" });
      assert.deepEqual(yield* Fiber.join(duplicate), { _tag: "sent", reply: "ok" });
      assert.equal(h.initiates(), 1);
      assert.equal(h.releases.get("m1"), 1);
    })), { timeout: 10_000 });

  it.effect("2 and 3: a send waiting behind a Stop is denied without a receipt; interrupting it before the permit admits nothing", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const hold = yield* Deferred.make<void>();
      const stopping = yield* Effect.forkChild(h.stop(hold));
      yield* h.until(() => h.log.includes("policy-commit"));
      const waiting = yield* Effect.forkChild(h.send("m1"));
      const abandoned = yield* Effect.forkChild(h.send("m2"));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(abandoned);
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(stopping);
      assert.deepEqual(yield* Fiber.join(waiting), { _tag: "denied" });
      assert.deepEqual([...h.receipts.keys()], []);
      assert.equal(h.initiates(), 0);
    })), { timeout: 10_000 });

  it.effect("4: interrupting a duplicate waiter leaves the original running; its reply completes it and release runs once", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const first = yield* Effect.forkChild(h.send("m1"));
      yield* h.until(() => h.log.includes("initiate:m1"));
      const duplicate = yield* Effect.forkChild(h.send("m1"));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(duplicate);
      assert.equal(h.releases.get("m1") ?? 0, 0);
      yield* h.reply("m1", "ok");
      assert.deepEqual(yield* Fiber.join(first), { _tag: "sent", reply: "ok" });
      assert.equal(h.releases.get("m1"), 1);
    })), { timeout: 10_000 });

  it.effect("5: the owner interrupted inside the section after initiate takes effect at the section exit; release once, receipt uncertain, later send reconciles", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const barrier = yield* Deferred.make<void>();
      const owner = yield* Effect.forkChild(h.send("m1", Deferred.await(barrier)));
      yield* h.until(() => h.log.includes("initiate:m1"));
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(owner));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(barrier, undefined);
      yield* Fiber.join(interrupting);
      const exit = yield* Effect.exit(Fiber.join(owner));
      assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(h.releases.get("m1"), 1);
      assert.equal(h.receipts.get("m1"), "uncertain");
      assert.deepEqual(yield* h.send("m1"), { _tag: "reconcile", state: "uncertain" });
      assert.equal(h.initiates(), 1);
    })), { timeout: 10_000 });

  it.effect("6: the owner interrupted while awaiting the reply; a duplicate receives the reconciliation and nothing is sent again", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const owner = yield* Effect.forkChild(h.send("m1"));
      yield* h.until(() => h.log.includes("initiate:m1"));
      const duplicate = yield* Effect.forkChild(h.send("m1"));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      assert.deepEqual(yield* Fiber.join(duplicate), { _tag: "reconcile", state: "uncertain" });
      assert.deepEqual(yield* h.send("m1"), { _tag: "reconcile", state: "uncertain" });
      assert.equal(h.initiates(), 1);
      assert.equal(h.releases.get("m1"), 1);
    })), { timeout: 10_000 });

  it.effect("7: closing the transport scope with a send in flight runs release once and keeps the receipt", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const owner = yield* Effect.forkChild(h.send("m1"));
      yield* h.until(() => h.log.includes("initiate:m1"));
      yield* Scope.close(h.transportScope, Exit.void);
      const outcome = yield* Fiber.join(owner);
      assert.deepEqual(outcome, { _tag: "reconcile", state: "uncertain" });
      assert.equal(h.releases.get("m1"), 1);
      assert.equal(h.receipts.get("m1"), "uncertain");
    })), { timeout: 10_000 });

  it.effect("8: a send queued behind the section when the transport scope closes admits nothing: no receipt, no initiation, interrupted; a later send initiates nothing", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holding = yield* Effect.forkChild(h.hold(entered, release));
      yield* Deferred.await(entered);
      const queued = yield* Effect.forkChild(h.send("m1"));
      yield* Effect.yieldNow;
      yield* Scope.close(h.transportScope, Exit.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holding);
      const exit = yield* Fiber.await(queued);
      assert.equal(h.initiates(), 0);
      assert.deepEqual([...h.receipts.keys()], []);
      assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      const later = yield* Effect.exit(h.send("m1"));
      assert.ok(Exit.isFailure(later) && Cause.hasInterruptsOnly(later.cause));
      assert.equal(h.initiates(), 0);
      assert.deepEqual([...h.receipts.keys()], []);
      assert.deepEqual([...h.releases.keys()], []);
    })), { timeout: 10_000 });

  it.effect("9: the transport scope closing between the initiation and its registration still owns the request: release once, receipt uncertain, the caller reconciles and nothing is sent again", () =>
    onGuidanceFile(Effect.gen(function* () {
      const h = yield* harness;
      const outcome = yield* Effect.exit(h.send("m1", Scope.close(h.transportScope, Exit.void)));
      assert.equal(h.releases.get("m1"), 1);
      assert.equal(h.receipts.get("m1"), "uncertain");
      assert.deepEqual(outcome, Exit.succeed({ _tag: "reconcile", state: "uncertain" }));
      const later = yield* Effect.exit(h.send("m1"));
      assert.ok(Exit.isFailure(later) && Cause.hasInterruptsOnly(later.cause));
      assert.equal(h.initiates(), 1);
      assert.equal(h.releases.get("m1"), 1);
    })), { timeout: 10_000 });
});

// the same ownership over the real native adapter and a loopback T3 peer that never answers unless told to: the receipt
// is classified from the adapter's sent boundary, release counts wrap the adapter's socket release, and the peer
// observes every Request frame and the socket's end
const nativeHarness = (answer = false) => Effect.gen(function* () {
  const peer = yield* envelopePeer((socket, frame) => {
    if (answer && frame._tag === "Request") socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: "ok" } }));
  });
  const envelope = yield* NativeEnvelope;
  const gate = yield* makeSupervisionGate(flagGuard(() => false));
  const transportScope = yield* Scope.make();
  const inFlight = yield* FiberMap.make<string, string>().pipe(Scope.provide(transportScope));
  const receipts = new Map<string, "admitted" | "uncertain" | "unsent">();
  const releases = new Map<string, number>();
  let initiations = 0;
  const send = (id: string, during: Effect.Effect<void> = Effect.void) => admitSend(gate, {
    identity: id,
    inFlight,
    prepare: () => Effect.sync((): SendPreparation<string> => {
      const receipt = receipts.get(id);
      if (receipt !== undefined) return { _tag: "Answer", value: `reconcile:${receipt}` };
      receipts.set(id, "admitted");
      return { _tag: "Initiate", initiate: envelope.initiate({
        endpoint: { baseUrl: peer.baseUrl, token: "fixture-token" },
        request: { id, tag: "fixture.action", payload: {} },
        maxPayload: 1024,
        handshakeTimeout: "5 seconds",
        onExit: () => Effect.succeed(NativeStep.done("replied")),
      }).pipe(
        Effect.map((flight): AdmittedInFlight<string> => {
          initiations++;
          return {
            // interrupted, the request is uncertain once its frame was handed to ws and unsent before
            result: flight.result.pipe(Effect.orElseSucceed(() => "failed"), Effect.onInterrupt(() =>
              Effect.flatMap(flight.sent, (sent) => Effect.sync(() => { receipts.set(id, sent ? "uncertain" : "unsent"); })))),
            release: Effect.sync(() => { releases.set(id, (releases.get(id) ?? 0) + 1); }).pipe(Effect.andThen(flight.release)),
          };
        }),
        Effect.tap(() => during)) };
    }),
    reconcile: Effect.sync(() => `reconcile:${receipts.get(id) ?? "none"}`),
  });
  const requested = peer.frame((frame) => frame.frame._tag === "Request").pipe(Effect.asVoid);
  return { peer, gate, send, receipts, releases, initiations: () => initiations, requested, transportScope };
});

describe("CT-LIN-05 ownership over the real native adapter", () => {
  it.live("a send queued behind the section when the transport scope closes opens no socket and writes no Request; a later send neither", () =>
    Effect.gen(function* () {
      const h = yield* nativeHarness();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holding = yield* Effect.forkChild(h.gate.admit(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))));
      yield* Deferred.await(entered);
      const queued = yield* Effect.forkChild(h.send("m1"));
      yield* Effect.yieldNow;
      yield* Scope.close(h.transportScope, Exit.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holding);
      const exit = yield* Fiber.await(queued);
      assert.equal(h.initiations(), 0);
      assert.deepEqual([...h.receipts.keys()], []);
      assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      const later = yield* Effect.exit(h.send("m1"));
      assert.ok(Exit.isFailure(later) && Cause.hasInterruptsOnly(later.cause));
      assert.equal(h.initiations(), 0);
      assert.deepEqual([...h.receipts.keys()], []);
      assert.deepEqual([...h.releases.keys()], []);
      assert.deepEqual(h.peer.texts(), []);
      assert.equal(h.peer.tcpConnections(), 0);
    }).pipe(onGuidanceFile, Effect.provide(NativeEnvelope.layer)), { timeout: 10_000 });

  it.live("the transport scope closing after the Request reached T3 but before its registration releases that socket; the caller reconciles uncertain and nothing is sent again", () =>
    Effect.gen(function* () {
      const h = yield* nativeHarness();
      const outcome = yield* Effect.exit(h.send("m1", h.requested.pipe(Effect.andThen(Scope.close(h.transportScope, Exit.void)))));
      assert.equal(h.releases.get("m1"), 1);
      assert.equal(h.receipts.get("m1"), "uncertain");
      assert.deepEqual(outcome, Exit.succeed("reconcile:uncertain"));
      yield* h.peer.closed;
      const later = yield* Effect.exit(h.send("m1"));
      assert.ok(Exit.isFailure(later) && Cause.hasInterruptsOnly(later.cause));
      assert.equal(h.initiations(), 1);
      assert.equal(h.peer.texts().length, 1);
      assert.equal(h.releases.get("m1"), 1);
    }).pipe(onGuidanceFile, Effect.provide(NativeEnvelope.layer)), { timeout: 10_000 });

  it.live("closing the transport scope with a registered send awaiting its reply releases the socket and the caller reconciles uncertain", () =>
    Effect.gen(function* () {
      const h = yield* nativeHarness();
      const owner = yield* Effect.forkChild(h.send("m1"));
      yield* h.requested;
      yield* Scope.close(h.transportScope, Exit.void);
      assert.equal(yield* Fiber.join(owner), "reconcile:uncertain");
      assert.equal(h.releases.get("m1"), 1);
      yield* h.peer.closed;
      assert.equal(h.peer.texts().length, 1);
    }).pipe(onGuidanceFile, Effect.provide(NativeEnvelope.layer)), { timeout: 10_000 });

  it.live("interrupting the owner while it awaits the reply releases the socket; its duplicate and a later send reconcile without another Request", () =>
    Effect.gen(function* () {
      const h = yield* nativeHarness();
      const owner = yield* Effect.forkChild(h.send("m1"));
      yield* h.requested;
      const duplicate = yield* Effect.forkChild(h.send("m1"));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      assert.equal(h.releases.get("m1"), 1);
      assert.equal(yield* Fiber.join(duplicate), "reconcile:uncertain");
      yield* h.peer.closed;
      assert.equal(yield* h.send("m1"), "reconcile:uncertain");
      assert.equal(h.initiations(), 1);
      assert.equal(h.peer.texts().length, 1);
    }).pipe(onGuidanceFile, Effect.provide(NativeEnvelope.layer)), { timeout: 10_000 });

  it.live("a reply completes the owner and its duplicate with one Request; the socket is released once", () =>
    Effect.gen(function* () {
      const h = yield* nativeHarness(true);
      const owner = yield* Effect.forkChild(h.send("m1"));
      const duplicate = yield* Effect.forkChild(h.send("m1"));
      assert.equal(yield* Fiber.join(owner), "replied");
      assert.equal(yield* Fiber.join(duplicate), "replied");
      assert.equal(h.releases.get("m1"), 1);
      yield* h.peer.closed;
      assert.equal(h.initiations(), 1);
      assert.equal(h.peer.texts().length, 1);
      assert.equal(h.receipts.get("m1"), "admitted");
    }).pipe(onGuidanceFile, Effect.provide(NativeEnvelope.layer)), { timeout: 10_000 });
});

// the section never runs two bodies at once
it.effect("the admission section serializes bodies", () => onGuidanceFile(Effect.gen(function* () {
  const gate = yield* makeSupervisionGate(flagGuard(() => false));
  let active = 0;
  let overlap = false;
  const body = gate.admit(() => Effect.gen(function* () {
    active++;
    if (active > 1) overlap = true;
    yield* Effect.yieldNow;
    active--;
  }));
  yield* Effect.all([body, body, body, body], { concurrency: "unbounded" });
  assert.equal(overlap, false);
})), { timeout: 10_000 });
