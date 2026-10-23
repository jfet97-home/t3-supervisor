import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";
import { hookPath, startHelperFixture, type HelperFixture } from "./support/int-helper-fixture.js";

// the real policy writers against the real helper transport on the one admission gate (plan 3.9 T-07, 3.11): production
// team runtime -> production helper transport -> platform fetch -> loopback socket, with the Settings and dashboard Stops of
// ProjectSupervisor/SupervisionControl forked as fibers of the case and joined. Unlike the hook stops of CT-LIN, which commit
// inside a peer hook while nothing holds the section, these Stops contend for the permit: each case records whether the Stop
// had committed when it was requested and the order of the commit against the POST's start. it.live: the webhook POST, the
// websocket RPC and the projection reads cross real loopback sockets

const runBatch = (f: HelperFixture) => Effect.gen(function* () {
  const binding = (yield* f.core.store.binding("p", "main"))!;
  yield* f.runtime.startCycle(binding);
  return yield* f.runtime.runHelperBatch(binding, f.threads, f.batches);
});

// whether the stored policy stops the main, read when the read runs (the policy client is never held across a section)
const stopped = (f: HelperFixture): Effect.Effect<boolean> => Effect.map(f.core.policy.get(), (policy) => policy.excludedThreadIds.includes("main")).pipe(Effect.orDie);

// each Stop is the page's policy read and the submit it then requests; the submit reaches the gate on the turn it starts
type Stop = (f: HelperFixture) => Effect.Effect<Effect.Effect<unknown, unknown>>;

// the Settings excluded-chat editor's Stop: the admitted thread-policy save the HTTP handler yields (t-02)
const settingsStop: Stop = (f) => Effect.map(f.core.policy.get().pipe(Effect.orDie), (policy) =>
  f.core.control.saveThreadPolicy({...policy, excludedThreadIds: [...policy.excludedThreadIds, "main"]}));

// the dashboard's Stop supervision control: the admitted chat-policy write and its bookkeeping
const dashboardStop: Stop = (f) => Effect.map(f.core.policy.get().pipe(Effect.orDie), (policy) =>
  f.core.supervisor.setChatSupervision({projectId: "p", mainThreadId: "main", enabled: false, policyGeneration: policy.generation}));

// the bound on the wait for a Stop that no section may hold: a Stop still waiting after it was held by one
const unheld = "10 seconds";

for (const [route, stop] of [["Settings", settingsStop], ["dashboard", dashboardStop]] as const) {
  it.live(`a ${route} Stop requested while the webhook POST starts inside its admission section waits for that section, commits after it, and no later cycle starts another request`, () => Effect.gen(function* () {
    const f = yield* startHelperFixture;
    const scope = yield* Effect.scope;
    const order: string[] = [];
    const submit = yield* stop(f);
    let stopping: Fiber.Fiber<unknown, unknown> | undefined;
    let receiptAtPostStart: unknown;
    let committedWhenRequested: boolean | undefined;
    f.state.onFetch = (url) => Effect.gen(function* () {
      if (!url.endsWith(hookPath)) return;
      order.push("post-start");
      if (stopping) return;
      // the POST starts inside the send's admission section: the Stop requested here, started at once, cannot take the permit
      stopping = yield* Effect.forkIn(Effect.tap(submit, () => Effect.sync(() => order.push("stop-committed"))), scope, {startImmediately: true});
      // an admitted Stop is one guidance transaction around its policy write, begun on this turn when nothing holds the permit;
      // this guidance read, issued on this turn too, then answers after that commit, and otherwise before the Stop begins
      receiptAtPostStart = (yield* f.receipt)?.state;
      committedWhenRequested = yield* stopped(f);
    });
    yield* runBatch(f);
    assert.ok(stopping, "the POST started");
    assert.equal(receiptAtPostStart, "posting", "the section committed the receipt before the POST started");
    assert.equal(committedWhenRequested, false, "the Stop waited while the send's section owned the POST start");
    yield* Fiber.join(stopping);
    assert.equal(yield* stopped(f), true, "the Stop committed after the section");
    assert.deepEqual(order, ["post-start", "stop-committed"]);
    assert.equal(f.posts().length, 1);
    const receipt = (yield* f.receipt)!;
    assert.equal(receipt.state, "posted", "the admitted POST kept its identity and was not cancelled by the Stop");

    // after the confirmed commit, a later cycle starts no request at all
    yield* runBatch(f);
    assert.deepEqual(order, ["post-start", "stop-committed"]);
    assert.equal(f.posts().length, 1);
    assert.deepEqual(yield* f.receipt, receipt);
  }), {timeout: 60_000});
}

it.live("a Settings Stop requested while the transport reads the helper over the network commits at once, and the send then posts nothing", () => Effect.gen(function* () {
  const f = yield* startHelperFixture;
  const scope = yield* Effect.scope;
  let committedDuringRead: boolean | undefined;
  let stopping: Fiber.Fiber<unknown, unknown> | undefined;
  // the second helper read is the transport's own, before its admission section; the peer answers it when this hook ends
  f.state.beforeHelperProjection = (read) => read !== 2 ? Effect.void : Effect.gen(function* () {
    stopping = yield* Effect.forkIn(yield* settingsStop(f), scope, {startImmediately: true});
    // a section held across the read would hold the Stop until this hook lets the peer answer: the bound ends that wait
    const ended = yield* Effect.timeoutOption(Fiber.join(stopping), unheld).pipe(Effect.orDie);
    committedDuringRead = Option.isSome(ended) && (yield* stopped(f));
  });
  let posts = 0;
  f.state.onFetch = (url) => Effect.sync(() => {if (url.endsWith(hookPath)) posts += 1;});
  yield* runBatch(f);
  if (stopping) yield* Fiber.join(stopping);
  assert.equal(committedDuringRead, true, "the Stop did not wait for the send's unrelated network read");
  assert.equal(posts, 0);
  assert.equal(f.posts().length, 0);
  assert.equal(yield* f.receipt, null);
  assert.equal((yield* f.request).state, "prepared");
}), {timeout: 60_000});
