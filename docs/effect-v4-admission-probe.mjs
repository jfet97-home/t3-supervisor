// executable probe for the plan 3.11 admission, in-flight lookup and cancellation-owner contract on exact effect 4.0.5
// run from a directory whose node_modules resolves effect 4.0.5: node effect-v4-admission-probe.mjs (prints JSON)
// fake adapter: initiate is synchronous handoff (socket bound), result awaits a reply, release is the local cleanup
import { Cause, Deferred, Effect, Exit, Fiber, FiberMap, Option, Semaphore } from "effect";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const harness = Effect.gen(function* () {
  const log = [];
  const receipts = new Map(); // durable receipt per identity: admitted | sent | uncertain
  const replies = new Map();
  const releases = new Map();
  let stopped = false;
  const admission = yield* Semaphore.make(1);
  const map = yield* FiberMap.make();
  const admit = (body) => Semaphore.withPermits(admission, 1)(Effect.uninterruptible(body));

  // production initiate is Effect.sync; the optional barrier only lets a test deliver an interruption inside the section
  const initiate = (id, barrier) => Effect.gen(function* () {
    log.push(`initiate:${id}`);
    const reply = yield* Deferred.make();
    replies.set(id, reply);
    let released = false;
    const release = Effect.sync(() => {
      if (released) return;
      released = true;
      releases.set(id, (releases.get(id) ?? 0) + 1);
      log.push(`release:${id}`);
    });
    if (barrier) yield* Deferred.await(barrier);
    return { result: Deferred.await(reply), release };
  });

  // outcome from the durable receipt when no live handle exists (reconcile only, never a new send)
  const fromReceipt = (id) => ({ _tag: "reconcile", state: receipts.get(id) ?? "none" });
  const settle = (id, exit) => Exit.isSuccess(exit) ? exit.value : fromReceipt(id);

  // the owner cell is filled inside the masked section together with the handle, so an interruption at the
  // section exit, while awaiting the reply, or from the request deadline always reaches the mapped operation
  const send = (id, options = {}) => Effect.suspend(() => {
    let owned;
    return Effect.gen(function* () {
      const decision = yield* admit(Effect.gen(function* () {
        const existing = yield* FiberMap.get(map, id);
        if (Option.isSome(existing)) return { _tag: "duplicate", fiber: existing.value };
        if (receipts.has(id)) return { _tag: "recorded" };
        if (stopped) return { _tag: "denied" };
        receipts.set(id, "admitted");
        log.push(`receipt:${id}`);
        const inFlight = yield* initiate(id, options.barrier);
        owned = yield* FiberMap.run(map, id, inFlight.result.pipe(
          Effect.map((reply) => { receipts.set(id, "sent"); return { _tag: "sent", reply }; }),
          Effect.onInterrupt(() => Effect.sync(() => { if (receipts.get(id) === "admitted") receipts.set(id, "uncertain"); })),
          Effect.ensuring(inFlight.release),
        ));
        return { _tag: "owner", fiber: owned };
      }));
      if (decision._tag === "denied") return { _tag: "denied" };
      if (decision._tag === "recorded") return fromReceipt(id);
      // duplicate waiters never own cancellation: interrupting one only stops its wait
      return settle(id, yield* Effect.exit(Fiber.join(decision.fiber)));
    }).pipe(Effect.onInterrupt(() => owned ? Fiber.interrupt(owned) : Effect.void));
  });

  const stop = admit(Effect.sync(() => { stopped = true; log.push("policy-commit"); log.push("bookkeeping"); }));
  const reply = (id, value) => Deferred.succeed(replies.get(id), value);
  const until = (pred) => Effect.gen(function* () { while (!pred()) yield* Effect.yieldNow; });
  return { log, receipts, releases, map, send, stop, reply, until, enable: () => { stopped = false; } };
});

const run = (name, body) => Effect.scoped(Effect.gen(function* () {
  const h = yield* harness;
  const result = yield* body(h);
  return { name, ...result, log: [...h.log], receipts: Object.fromEntries(h.receipts), releases: Object.fromEntries(h.releases) };
})).pipe(Effect.timeout("2 seconds"), Effect.exit, Effect.map((exit) => Exit.isSuccess(exit) ? exit.value : { name, failed: String(Cause.squash(exit.cause)) }));

const cases = [
  run("duplicate-while-pending", (h) => Effect.gen(function* () {
    const a = yield* Effect.forkChild(h.send("m1"));
    yield* h.until(() => h.log.includes("initiate:m1"));
    const b = yield* Effect.forkChild(h.send("m1"));
    yield* Effect.yieldNow;
    yield* h.reply("m1", "ok");
    return { first: yield* Fiber.join(a), duplicate: yield* Fiber.join(b), initiates: h.log.filter((x) => x.startsWith("initiate")).length };
  })),
  run("duplicate-waiter-interrupted", (h) => Effect.gen(function* () {
    const a = yield* Effect.forkChild(h.send("m1"));
    yield* h.until(() => h.log.includes("initiate:m1"));
    const b = yield* Effect.forkChild(h.send("m1"));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(b);
    const releasedAfterDuplicateInterrupt = h.releases.get("m1") ?? 0;
    yield* h.reply("m1", "ok");
    return { releasedAfterDuplicateInterrupt, first: yield* Fiber.join(a) };
  })),
  run("owner-interrupted-at-handoff", (h) => Effect.gen(function* () {
    const barrier = yield* Deferred.make();
    const a = yield* Effect.forkChild(h.send("m1", { barrier }));
    yield* h.until(() => h.log.includes("initiate:m1"));
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(a));
    yield* Effect.yieldNow;
    const registeredBeforeRelease = h.receipts.get("m1");
    yield* Deferred.succeed(barrier, undefined);
    yield* Fiber.join(interrupting);
    const ownerExit = yield* Effect.exit(Fiber.join(a));
    const later = yield* h.send("m1");
    return { registeredBeforeRelease, ownerInterrupted: Exit.isFailure(ownerExit) && Cause.hasInterruptsOnly(ownerExit.cause), later, initiates: h.log.filter((x) => x.startsWith("initiate")).length };
  })),
  run("owner-interrupted-awaiting-reply", (h) => Effect.gen(function* () {
    const a = yield* Effect.forkChild(h.send("m1"));
    yield* h.until(() => h.log.includes("initiate:m1"));
    const dup = yield* Effect.forkChild(h.send("m1"));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(a);
    const duplicate = yield* Fiber.join(dup);
    const later = yield* h.send("m1");
    return { duplicate, later, initiates: h.log.filter((x) => x.startsWith("initiate")).length };
  })),
  run("stop-while-reply-pending", (h) => Effect.gen(function* () {
    const a = yield* Effect.forkChild(h.send("m1"));
    yield* h.until(() => h.log.includes("initiate:m1"));
    yield* h.stop;
    const stopCompletedWhilePending = h.receipts.get("m1") === "admitted";
    yield* h.reply("m1", "ok");
    return { stopCompletedWhilePending, first: yield* Fiber.join(a) };
  })),
  run("stop-first-then-send", (h) => Effect.gen(function* () {
    yield* h.stop;
    return { send: yield* h.send("m1") };
  })),
  run("interrupt-while-waiting-for-permit", (h) => Effect.gen(function* () {
    const hold = yield* Deferred.make();
    // m0 holds the section on its initiate barrier while m1 waits for the permit
    const blocker = yield* Effect.forkChild(h.send("m0", { barrier: hold }));
    yield* h.until(() => h.log.includes("initiate:m0"));
    const waiting = yield* Effect.forkChild(h.send("m1"));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiting);
    yield* Deferred.succeed(hold, undefined);
    yield* h.reply("m0", "ok");
    yield* Fiber.join(blocker);
    return { m1Receipt: h.receipts.has("m1"), m1Initiated: h.log.includes("initiate:m1") };
  })),
];

const shutdown = Effect.gen(function* () {
  let snapshot;
  yield* Effect.scoped(Effect.gen(function* () {
    const h = yield* harness;
    snapshot = h;
    yield* Effect.forkChild(h.send("m1"));
    yield* h.until(() => h.log.includes("initiate:m1"));
  }));
  return { name: "shutdown-closes-map", releases: Object.fromEntries(snapshot.releases), receipts: Object.fromEntries(snapshot.receipts) };
});

const results = await Effect.runPromise(Effect.all([...cases, shutdown], { concurrency: 1 }));
console.log(JSON.stringify({ effectVersion: require("effect/package.json").version, results }, null, 1));
