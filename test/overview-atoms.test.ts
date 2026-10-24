import assert from "node:assert/strict";
import { beforeAll, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { OverviewRangeError, readOverviewPages, type DashboardOverviewInfo } from "../src/dashboard-overview.js";
import { scopedRegistry } from "./support/g7-page.js";
import { abortOf, held, json, liveSleep, makeBrowser, until, type SentRequest } from "./support/g7-browser.js";

// target regressions of the work overview over atoms (CT-UI-OVERVIEW-01): the loaded range and load-more, the retained
// last read and its message, change subscriptions only while enabled and visible, and interruption on deactivation. the waits for a
// read are bounded on the live clock; the stream tests drive actual decoded invalidation hints

const browser = makeBrowser();
type Overview = typeof import("../ui/src/overview.js");
let ui: Overview;

beforeAll(() => Effect.gen(function* () {
  yield* browser.install;
  browser.local.set("supervisor-session", "session-1");
  ui = yield* Effect.promise(() => import("../ui/src/overview.js"));
}));

const row = (id: string) => ({projectId: "p", mainThreadId: id, title: id, supervisorThreadId: "s", nativeState: "quiet" as const,
  supervision: "enabled" as const, objective: null, reason: "", taskStatus: null, planStatus: null, assessment: null, attention: [], updatedAt: null});
const all = Array.from({length: 230}, (_, i) => row(`work-${i}`));
const page = (offset: number, revision = "one", rows = all): DashboardOverviewInfo => ({revision, observedAt: 1, available: true, globallyEnabled: true,
  offset, limit: 100, total: rows.length, attentionTotal: 0, hasMore: offset + 100 < rows.length, projects: [], work: rows.slice(offset, offset + 100)});
const reads = () => browser.sent.filter((request) => request.path === "/api/guidance/dashboard-overview");
const offsets = (requests: ReadonlyArray<SentRequest>) => requests.map((request) => [request.search.get("offset"), request.search.get("limit")]);
const loaded = (result: AsyncResult.AsyncResult<DashboardOverviewInfo, unknown>) => Option.match(AsyncResult.value(result), {onNone: () => 0, onSome: (value) => value.work.length});

it.effect("CT-UI-OVERVIEW-01 the overview reads 100 conversations, load-more adds 100 keeping prior pages, a failure keeps the last read and its message, and deactivation interrupts the read in flight", () => Effect.gen(function* () {
  browser.sent.length = 0;
  browser.state.reply = (request) => json(page(Number(request.search.get("offset"))));
  const registry = yield* scopedRegistry();
  const model = ui.makeOverview();
  const seen: Array<AsyncResult.AsyncResult<DashboardOverviewInfo, unknown>> = [];
  const stop = registry.subscribe(model.live, (value) => { seen.push(value); }, { immediate: true });
  assert.equal(reads().length, 0, "nothing is read before the overview is enabled");
  registry.set(model.enabled, true);
  yield* until(registry, model.read, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the first read");
  assert.equal(loaded(registry.get(model.read)), 100);
  assert.deepEqual(offsets(reads()), [["0", "100"]]);

  browser.sent.length = 0;
  seen.length = 0;
  registry.set(model.more, true);
  registry.refresh(model.read);
  yield* until(registry, model.read, (result) => AsyncResult.isSuccess(result) && !result.waiting && loaded(result) === 200, "load more");
  assert.deepEqual(offsets(reads()), [["0", "100"], ["100", "100"]]);
  assert.ok(seen.every((result) => loaded(result) >= 100), "prior pages stay visible while more load");
  assert.equal(registry.get(model.more), false, "a load-more request is used once");

  // a refresh keeps the loaded range
  browser.sent.length = 0;
  registry.refresh(model.read);
  yield* until(registry, model.read, (result) => AsyncResult.isSuccess(result) && !result.waiting, "the refresh");
  assert.deepEqual(offsets(reads()), [["0", "100"], ["100", "100"]]);

  browser.state.reply = () => json({message: "Unavailable."}, 500);
  registry.refresh(model.read);
  const failed = yield* until(registry, model.read, (result) => AsyncResult.isFailure(result) && !result.waiting, "the failed refresh");
  assert.deepEqual(ui.overviewView(failed, true), {data: Option.getOrNull(AsyncResult.value(failed)), loading: false,
    error: "The work overview could not be refreshed. The last successful read is kept; current state may have changed."});
  assert.equal(loaded(failed), 200, "the last successful read is kept");
  registry.refresh(model.read);
  const again = yield* until(registry, model.read, (result) => AsyncResult.isFailure(result) && !result.waiting, "a second failed refresh");
  assert.equal(loaded(again), 200, "repeated failures keep the latest success");
  browser.state.reply = held;
  const before = browser.sent.length;
  registry.refresh(model.read);
  const refreshing = registry.get(model.read);
  assert.deepEqual(ui.overviewView(refreshing, true).error, "", "the message clears when the next read starts");
  assert.equal(ui.overviewView(refreshing, true).loading, true);

  // deactivation interrupts the read in flight and keeps the last result without loading
  const inFlight = yield* browser.request((request) => browser.sent.indexOf(request) >= before, "the held read");
  registry.set(model.enabled, false);
  yield* abortOf(inFlight.signal);
  assert.deepEqual(ui.overviewView(registry.get(model.read), false).loading, false);
  assert.equal(loaded(registry.get(model.read)), 200);
  stop();
  registry.dispose();
}), { timeout: 10_000 });

it.effect("the overview refreshes its loaded prefix on coalesced hints and retains hidden and disabled reads", () => Effect.gen(function* () {
  browser.sent.length = 0;
  browser.state.reply = request => json(page(Number(request.search.get("offset"))));
  const registry = yield* scopedRegistry();
  const model = ui.makeOverview();
  registry.set(model.enabled, true);
  const stop = registry.subscribe(model.live, () => undefined, {immediate: true});
  yield* until(registry, model.read, result => AsyncResult.isSuccess(result) && !result.waiting, "first page");
  yield* browser.request(request => request.path === "/api/events", "stream");
  registry.set(model.more, true); registry.refresh(model.read);
  yield* until(registry, model.read, result => loaded(result) === 200 && !result.waiting, "loaded prefix");
  browser.sent.length = 0;
  browser.hint(["overview"]); browser.hint(["overview"]);
  yield* browser.request(() => reads().length === 2, "one prefix refresh");
  yield* until(registry, model.read, result => !result.waiting, "refresh settled");
  assert.deepEqual(offsets(reads()), [["0", "100"], ["100", "100"]]);
  browser.visibility("hidden");
  browser.sent.length = 0;
  browser.hint(["overview"]);
  yield* liveSleep("80 millis");
  assert.equal(reads().length, 0);
  browser.visibility("visible");
  stop(); registry.set(model.enabled, false);
  registry.dispose();
}), {timeout: 10_000});

it.effect("the Effect range reader keeps the loaded range, restarts a reordered prefix once and rejects incoherent pages", () => Effect.gen(function* () {
  const calls: number[] = [];
  const retained = yield* readOverviewPages((offset) => Effect.sync(() => { calls.push(offset); return page(offset); }), 200);
  assert.equal(retained.work.length, 200);
  assert.equal(retained.work[150]?.mainThreadId, "work-150");
  assert.deepEqual(calls, [0, 100]);
  let count = 0;
  const promoted = [all[220]!, ...all.filter((item) => item.mainThreadId !== "work-220")];
  const reordered = yield* readOverviewPages((offset) => Effect.sync(() => page(offset, ++count === 1 ? "one" : "two", count === 1 ? all : promoted)), 200);
  assert.equal(count, 4, "a changed second page restarts the full prefix");
  assert.equal(reordered.work[0]?.mainThreadId, "work-220");
  assert.equal(new Set(reordered.work.map((item) => item.mainThreadId)).size, 200);
  const changing = yield* Effect.exit(readOverviewPages((offset) => Effect.sync(() => page(offset, String(++count))), 200));
  assert.deepEqual(changing, Exit.fail(new OverviewRangeError({reason: "overview_changed_during_read"})));
  const shifted = yield* Effect.exit(readOverviewPages(() => Effect.succeed(page(5)), 100));
  assert.deepEqual(shifted, Exit.fail(new OverviewRangeError({reason: "invalid_overview_page"})));
  const duplicated = yield* Effect.exit(readOverviewPages((offset) => Effect.succeed({...page(offset), work: page(0).work}), 200));
  assert.deepEqual(duplicated, Exit.fail(new OverviewRangeError({reason: "invalid_overview_page"})));
}), { timeout: 10_000 });
