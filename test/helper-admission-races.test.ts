import assert from "node:assert/strict";
import { Effect } from "effect";
import { it, type TestContext } from "vitest";
import { after } from "./support/node-test.js";
import { hookPath, startHelperFixture, type HelperFixture } from "./support/int-helper-fixture.js";
import { policyService } from "./support/store-units.js";

// the real policy writers against the real helper transport on the one admission gate (plan 3.9 T-07, 3.11): production
// team runtime -> production helper transport -> platform fetch -> loopback socket, with the Settings and dashboard Stops of
// ProjectSupervisor/SupervisionControl requested as effects and awaited. Unlike the callback stops of CT-LIN, which commit
// synchronously inside a peer callback while nothing holds the section, these Stops contend for the permit: each case
// records whether the Stop had committed when it was requested and the order of the commit against the POST's start

const fixture = async (t: TestContext): Promise<HelperFixture> => {
  const f = await startHelperFixture();
  after(t, f.close);
  return f;
};

const runBatch = async (f: HelperFixture) => {
  const binding = (await f.core.store.binding("p", "main"))!;
  f.runtime.startCycle(binding);
  return f.runtime.runHelperBatch(binding, f.threads, f.batches, AbortSignal.timeout(20_000));
};

// the stored policy, read synchronously on the caller's turn (the policy client is never held across a turn)
const policyNow = (f: HelperFixture) => Effect.runSync(policyService(f.core.policy).get());
const stopped = (f: HelperFixture): boolean => policyNow(f).excludedThreadIds.includes("main");

// the Settings excluded-chat editor's Stop: the admitted thread-policy save the HTTP handler yields (t-02)
const settingsStop = (f: HelperFixture): Promise<unknown> => {
  const policy = policyNow(f);
  return Effect.runPromise(f.core.supervision.saveThreadPolicy({...policy, excludedThreadIds: [...policy.excludedThreadIds, "main"]}));
};

// the dashboard's Stop supervision control: the admitted chat-policy write and its bookkeeping
const dashboardStop = (f: HelperFixture): Promise<unknown> => f.core.supervision.setChatSupervision(
  {projectId: "p", mainThreadId: "main", enabled: false, policyGeneration: policyNow(f).generation}, AbortSignal.timeout(20_000));

for (const [route, stop] of [["Settings", settingsStop], ["dashboard", dashboardStop]] as const) {
  it(`a ${route} Stop requested while the webhook POST starts inside its admission section waits for that section, commits after it, and no later cycle starts another request`, {timeout: 60_000}, async (t) => {
    const f = await fixture(t);
    const order: string[] = [];
    let stopping: Promise<unknown> | undefined;
    let committedWhenRequested: boolean | undefined;
    f.state.onFetch = (url) => {
      if (!url.endsWith(hookPath)) return;
      order.push("post-start");
      if (stopping) return;
      // the POST starts synchronously inside the send's admission section: the Stop requested here cannot take the permit
      stopping = stop(f).then(() => {order.push("stop-committed");});
      committedWhenRequested = stopped(f);
    };
    await runBatch(f);
    assert.ok(stopping, "the POST started");
    assert.equal(committedWhenRequested, false, "the Stop waited while the send's section owned the POST start");
    await stopping;
    assert.equal(stopped(f), true, "the Stop committed after the section");
    assert.deepEqual(order, ["post-start", "stop-committed"]);
    assert.equal(f.posts().length, 1);
    const receipt = f.receipt()!;
    assert.equal(receipt.state, "posted", "the admitted POST kept its identity and was not cancelled by the Stop");

    // after the confirmed commit, a later cycle starts no request at all
    await runBatch(f);
    assert.deepEqual(order, ["post-start", "stop-committed"]);
    assert.equal(f.posts().length, 1);
    assert.deepEqual(f.receipt(), receipt);
  });
}

it("a Settings Stop requested while the transport reads the helper over the network commits at once, and the send then posts nothing", {timeout: 60_000}, async (t) => {
  const f = await fixture(t);
  let committedWhenRequested: boolean | undefined;
  let stopping: Promise<unknown> | undefined;
  // the second helper read is the transport's own, before its admission section; the peer has not answered it yet
  f.state.beforeHelperProjection = (read) => {
    if (read !== 2) return;
    stopping = settingsStop(f);
    committedWhenRequested = stopped(f);
  };
  let posts = 0;
  f.state.onFetch = (url) => {if (url.endsWith(hookPath)) posts += 1;};
  await runBatch(f);
  await stopping;
  assert.equal(committedWhenRequested, true, "the Stop did not wait for the send's unrelated network read");
  assert.equal(posts, 0);
  assert.equal(f.posts().length, 0);
  assert.equal(f.receipt(), null);
  assert.equal(f.request().state, "prepared");
});
