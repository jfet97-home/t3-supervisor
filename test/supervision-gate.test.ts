import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FiberMap, Scope } from "effect";
import { admitSend, makeSupervisionGate, type AdmittedInFlight, type GateGuard } from "../src/supervision-gate.js";

// CT-LIN-05, the executable admission contract (plan 3.11), against a fake transport whose initiate is a synchronous
// handoff (an optional barrier only lets a test deliver an interruption inside the section) and whose reply waits on a
// Deferred; Stop is a section that commits the policy and then the bookkeeping

type Outcome = { readonly _tag: "sent"; readonly reply: string } | { readonly _tag: "denied" } | { readonly _tag: "reconcile"; readonly state: string };

const harness = Effect.gen(function* () {
  const log: string[] = [];
  const receipts = new Map<string, "admitted" | "sent" | "uncertain">();
  const replies = new Map<string, Deferred.Deferred<string>>();
  const releases = new Map<string, number>();
  let stopped = false;
  const guard: GateGuard = { scopeEnabled: () => !stopped, supervisionStopped: () => stopped, workflowEditingEnabled: () => !stopped };
  const gate = yield* makeSupervisionGate(guard);
  const transportScope = yield* Scope.make();
  const inFlight = yield* FiberMap.make<string, Outcome>().pipe(Scope.provide(transportScope));

  const initiate = (id: string, barrier?: Deferred.Deferred<void>) => Effect.gen(function* () {
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
    if (barrier) yield* Deferred.await(barrier);
    const result = Deferred.await(reply).pipe(
      Effect.map((value): Outcome => { receipts.set(id, "sent"); return { _tag: "sent", reply: value }; }),
      Effect.onInterrupt(() => Effect.sync(() => { if (receipts.get(id) === "admitted") receipts.set(id, "uncertain"); })),
    );
    return { result, release } satisfies AdmittedInFlight<Outcome>;
  });

  const fromReceipt = (id: string): Outcome => ({ _tag: "reconcile", state: receipts.get(id) ?? "none" });
  const send = (id: string, barrier?: Deferred.Deferred<void>) => admitSend(gate, {
    identity: id,
    inFlight,
    prepare: (current) => Effect.sync(() => {
      if (receipts.has(id)) return { _tag: "Answer" as const, value: fromReceipt(id) };
      if (current.supervisionStopped("main-chat")) return { _tag: "Answer" as const, value: { _tag: "denied" } as Outcome };
      receipts.set(id, "admitted");
      log.push(`receipt:${id}`);
      return { _tag: "Initiate" as const, initiate: initiate(id, barrier) };
    }),
    reconcile: Effect.sync(() => fromReceipt(id)),
  });
  const stop = (barrier?: Deferred.Deferred<void>) => gate.admit(() => Effect.gen(function* () {
    stopped = true;
    log.push("policy-commit");
    if (barrier) yield* Deferred.await(barrier);
    log.push("bookkeeping");
  }));
  const reply = (id: string, value: string) => Deferred.succeed(replies.get(id)!, value);
  const until = (condition: () => boolean) => Effect.gen(function* () { while (!condition()) yield* Effect.yieldNow; });
  const initiates = () => log.filter((entry) => entry.startsWith("initiate")).length;
  return { log, receipts, releases, send, stop, reply, until, initiates, transportScope };
});

describe("CT-LIN-05 admission section", () => {
  it.effect("1: a Stop completes while an admitted send awaits its reply; the send keeps its identity and a duplicate initiates nothing", () =>
    Effect.gen(function* () {
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
    }), { timeout: 10_000 });

  it.effect("2 and 3: a send waiting behind a Stop is denied without a receipt; interrupting it before the permit admits nothing", () =>
    Effect.gen(function* () {
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
    }), { timeout: 10_000 });

  it.effect("4: interrupting a duplicate waiter leaves the original running; its reply completes it and release runs once", () =>
    Effect.gen(function* () {
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
    }), { timeout: 10_000 });

  it.effect("5: the owner interrupted inside the section after initiate takes effect at the section exit; release once, receipt uncertain, later send reconciles", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const barrier = yield* Deferred.make<void>();
      const owner = yield* Effect.forkChild(h.send("m1", barrier));
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
    }), { timeout: 10_000 });

  it.effect("6: the owner interrupted while awaiting the reply; a duplicate receives the reconciliation and nothing is sent again", () =>
    Effect.gen(function* () {
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
    }), { timeout: 10_000 });

  it.effect("7: closing the transport scope with a send in flight runs release once and keeps the receipt", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const owner = yield* Effect.forkChild(h.send("m1"));
      yield* h.until(() => h.log.includes("initiate:m1"));
      yield* Scope.close(h.transportScope, Exit.void);
      const outcome = yield* Fiber.join(owner);
      assert.deepEqual(outcome, { _tag: "reconcile", state: "uncertain" });
      assert.equal(h.releases.get("m1"), 1);
      assert.equal(h.receipts.get("m1"), "uncertain");
    }), { timeout: 10_000 });
});

// the section never runs two bodies at once
it.effect("the admission section serializes bodies", () => Effect.gen(function* () {
  const gate = yield* makeSupervisionGate({ scopeEnabled: () => true, supervisionStopped: () => false, workflowEditingEnabled: () => true });
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
}), { timeout: 10_000 });
