import assert from "node:assert/strict";
import {beforeAll, it} from "@effect/vitest";
import {Effect, Option} from "effect";
import {AsyncResult} from "effect/reactivity";
import {overviewPage, overviewWorkPage} from "../src/dashboard-overview.js";
import {scopedRegistry} from "./support/g7-page.js";
import {abortOf, held, json, liveSleep, makeBrowser, until} from "./support/g7-browser.js";

const browser = makeBrowser();
let ui: typeof import("../ui/src/overview.js");
beforeAll(() => Effect.gen(function*() {
  yield* browser.install; browser.local.set("supervisor-session", "session-1");
  ui = yield* Effect.promise(() => import("../ui/src/overview.js"));
}));
const rows = Array.from({length: 230}, (_, i) => ({projectId: "p", mainThreadId: `work-${String(i).padStart(3, "0")}`, title: `Work ${i}`, supervisorThreadId: "s", nativeState: "quiet" as const, supervision: "enabled" as const, objective: null, reason: "", taskStatus: null, planStatus: null, assessment: null, attention: [], updatedAt: null}));
const reads = () => browser.sent.filter(request => request.path === "/api/guidance/dashboard-overview");
const reply = (request: (typeof browser.sent)[number]) => json({revision: "one", observedAt: 1, available: true, globallyEnabled: true, projects: [], ...overviewWorkPage(rows, overviewPage(Object.fromEntries(request.search)))});
const settled = (registry: Parameters<typeof until>[0], model: ReturnType<typeof ui.makeOverview>) => until(registry, model.read, result => AsyncResult.isSuccess(result) && !result.waiting, "page settled");

it.effect("full-collection query selects an unloaded match, retains failures and cancels deactivation without resetting selection", () => Effect.gen(function*() {
  browser.sent.length = 0; browser.state.reply = reply;
  const registry = yield* scopedRegistry(); const model = ui.makeOverview();
  const stop = registry.mount(model.live);
  assert.equal(reads().length, 0);
  registry.set(model.enabled, true); yield* settled(registry, model);
  assert.equal(Option.getOrThrow(AsyncResult.value(registry.get(model.read))).work.length, 25);
  registry.set(model.selection, {q: "Work 229", projectId: "p", filter: "all", page: 1});
  yield* until(registry, model.read, result => AsyncResult.isSuccess(result) && !result.waiting && result.value.query.q === "Work 229", "match beyond old prefix");
  assert.equal(Option.getOrThrow(AsyncResult.value(registry.get(model.read))).work[0]!.mainThreadId, "work-229");
  assert.equal(reads().at(-1)!.search.get("q"), "Work 229");
  browser.state.reply = () => json({message: "Unavailable"}, 500); registry.refresh(model.read);
  const failed = yield* until(registry, model.read, result => AsyncResult.isFailure(result) && !result.waiting, "failed refresh");
  assert.equal(ui.overviewView(failed, true).data?.work[0]!.mainThreadId, "work-229");
  assert.match(ui.overviewView(failed, true).error, /last successful read/);
  browser.state.reply = held; const before = browser.sent.length; registry.refresh(model.read);
  const inFlight = yield* browser.request(request => browser.sent.indexOf(request) >= before && request.path.endsWith("dashboard-overview"), "held page read");
  registry.set(model.enabled, false); yield* abortOf(inFlight.signal);
  assert.equal(registry.get(model.selection).q, "Work 229");
  assert.equal(ui.overviewView(registry.get(model.read), false).loading, false);
  stop(); registry.dispose();
}), {timeout: 10_000});

it.effect("coalesced hints refresh the selected page once; hidden and unmounted reads stay idle", () => Effect.gen(function*() {
  browser.sent.length = 0; browser.state.reply = reply;
  const registry = yield* scopedRegistry(); const model = ui.makeOverview();
  registry.set(model.selection, {q: "", projectId: "p", filter: "all", page: 3});
  registry.set(model.enabled, true); const stop = registry.mount(model.live);
  yield* settled(registry, model); yield* browser.request(request => request.path === "/api/events", "stream");
  assert.equal(reads().at(-1)!.search.get("offset"), "50");
  browser.sent.length = 0; browser.hint(["overview"]); browser.hint(["overview"]);
  yield* browser.request(() => reads().length === 1, "one selected-page refresh");
  yield* settled(registry, model);
  assert.equal(reads()[0]!.search.get("offset"), "50"); assert.equal(reads()[0]!.search.get("limit"), "25");
  browser.visibility("hidden"); browser.sent.length = 0; browser.hint(["overview"]); yield* liveSleep("80 millis");
  assert.equal(reads().length, 0);
  browser.visibility("visible"); stop(); registry.set(model.enabled, false); registry.dispose();
}), {timeout: 10_000});
