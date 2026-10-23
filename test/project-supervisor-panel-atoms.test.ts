import assert from "node:assert/strict";
import { it as effectIt } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, it } from "vitest";
import type { ProjectSupervisorInfo, ProjectSupervisorSaveInput } from "../src/project-supervisor-contract.js";
import type { WorkflowProgressSnapshot } from "../src/workflow-progress.js";
import { supervisorSnapshot } from "./support/c3b-project-supervisor.js";

// target regressions of the project supervisor panel atoms (WP-S7-PS) over a stubbed browser: drafts and reads, admitted
// settings and chat changes, the chat supervision poll and live progress pages

const originals = new Map<string, PropertyDescriptor | undefined>();
const install = (key: string, value: unknown) => {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
};

interface Sent {readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly body: unknown; readonly signal: AbortSignal | null}
const sent: Sent[] = [];
let reply: (request: Sent) => Promise<Response> = async () => new Response("{}", {status: 500});
const storage = new Map<string, string>();

type Core = typeof import("../ui/src/atoms.js");
type Panel = typeof import("../ui/src/project-supervisor.js");
let core: Core;
let ps: Panel;

beforeAll(async () => {
  install("location", {origin: "http://supervisor.test", pathname: "/"});
  install("window", new EventTarget());
  install("document", {visibilityState: "visible", hidden: false});
  install("localStorage", {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);},
    removeItem: (key: string) => {storage.delete(key);}});
  install("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://supervisor.test");
    const body = init?.body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(init.body)) as unknown : undefined;
    const request = {method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body, signal: init?.signal ?? null};
    sent.push(request);
    return reply(request);
  });
  storage.set("supervisor-session", "session-1");
  core = await import("../ui/src/atoms.js");
  ps = await import("../ui/src/project-supervisor.js");
});

afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// resolves with the first value of the atom that satisfies the predicate
const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {stop();reject(new Error(`${label} not reached`));}, 5_000);
    const stop = registry.subscribe(atom, value => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      queueMicrotask(() => stop());
      resolve(value);
    }, {immediate: true});
  });

// a response the test releases, and a signal that the request reached the stub
const pending = () => {
  let release!: (response: Response) => void;
  let reached!: () => void;
  return {
    response: new Promise<Response>(resolve => {release = resolve;}),
    reached: new Promise<void>(resolve => {reached = resolve;}),
    arrive: () => reached(),
    release: (response: Response) => release(response),
  };
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const isPost = (path: string) => (request: Sent) => request.method === "POST" && request.path === path;
const isRead = (request: Sent) => request.method === "GET" && request.path === "/api/guidance/project-supervisor";

const snapshot: ProjectSupervisorInfo = supervisorSnapshot;
const scopeA = () => core.scopeKey("project", "task-thread");
const projectKey = () => ps.projectSupervisorKey(null, "project");
const saveInput = (expectedGeneration: number): ProjectSupervisorSaveInput => ({projectId: "project", mainThreadId: "task-thread", expectedGeneration,
  modelSelection: snapshot.settings.modelSelection, monitoring: {intervalMinutes: 12, activityThreshold: 10}, teamSettings: {maxHelpersPerRoot: 3}});
// a panel showing the snapshot for chat A with a dirty monitoring draft
const showSnapshot = (registry: AtomRegistry.AtomRegistry) => {
  const shown = ps.settleRead({view: registry.get(ps.projectSupervisorView(projectKey())), draft: null}, "project", scopeA(), {snapshot, readAt: 1}, false);
  registry.set(ps.projectSupervisorView(projectKey()), {...shown.view, scope: scopeA()});
  assert.ok(shown.draft);
  registry.set(ps.projectSupervisorDraft(projectKey()), {...shown.draft, monitoringValue: {intervalMinutes: "12", activityThreshold: "10"}});
};

it("a read keeps every dirty draft field, moves only clean fields and the expected generation, and only an explicit refresh reads over a dirty shown draft", {timeout: 10_000}, () => {
  const first = ps.mergeLoadedDraft(null, "project", snapshot);
  assert.equal(first.keptDirty, false);
  assert.equal(first.draft.expectedGeneration, 7);
  const edited = {...first.draft, monitoringValue: {intervalMinutes: "12", activityThreshold: "10"}};
  const newer = {...snapshot, settings: {...snapshot.settings, generation: 8, modelSelection: {instanceId: "provider-one", model: "steady-model", options: []},
    monitoring: {intervalMinutes: 9, activityThreshold: 20}}};
  const merged = ps.mergeLoadedDraft(edited, "project", newer);
  assert.deepEqual(merged.draft.monitoringValue, {intervalMinutes: "12", activityThreshold: "10"}, "the dirty field keeps the user's value");
  assert.deepEqual(merged.draft.monitoringBaseline, {intervalMinutes: "9", activityThreshold: "20"});
  assert.deepEqual(merged.draft.modelValue, newer.settings.modelSelection, "a clean field takes the new saved value");
  assert.equal(merged.draft.expectedGeneration, 8);
  assert.equal(merged.keptDirty, true);

  const view = {scope: "s", snapshot: null, readAt: null, message: null, blocked: true, operation: null, chat: null, chatMessage: null};
  const refreshed = ps.settleRead({view, draft: edited}, "project", "s", {snapshot: newer, readAt: 5}, true);
  assert.equal(refreshed.view.blocked, false, "a verified read lifts the block after an unconfirmed outcome");
  assert.deepEqual(refreshed.view.message, {scope: "s", alert: false, text: "Supervisor status refreshed. Your unsaved draft was kept against the latest saved generation."});
  assert.equal(ps.settleRead({view, draft: first.draft}, "project", "s", {snapshot: newer, readAt: 5}, true).view.message?.text, "Supervisor status refreshed from T3.");
  assert.equal(ps.settleRead({view, draft: edited}, "project", "s", {snapshot: newer, readAt: 5}, false).view.message, null, "an automatic read reports nothing");

  const panel = {projectId: "project", connected: true, saving: false, forceRefresh: false, dirty: true, shown: true, completedKey: null, requestKey: "k1"};
  assert.equal(ps.snapshotReadNeeded(panel), false, "no automatic read over a dirty draft of the shown snapshot");
  assert.equal(ps.snapshotReadNeeded({...panel, forceRefresh: true}), true, "an explicit refresh reads over it");
  assert.equal(ps.snapshotReadNeeded({...panel, forceRefresh: true, saving: true}), false, "nothing reads while saving");
  assert.equal(ps.snapshotReadNeeded({...panel, shown: false}), true, "another chat's snapshot is read and merged");
  assert.equal(ps.snapshotReadNeeded({...panel, dirty: false, completedKey: "k1"}), false, "each scope revision is read once");
  assert.equal(ps.snapshotReadNeeded({...panel, dirty: false, connected: false}), false);
});

it("a save is admitted once against the draft's expected generation and applies its verified outcome with no panel mounted", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  showSnapshot(registry);
  const post = pending();
  reply = async request => {
    if (!isPost("/api/guidance/project-supervisor")(request)) return json({}, 500);
    post.arrive();
    return post.response;
  };
  ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
  ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
  await post.reached;
  const operation = registry.get(ps.projectSupervisorView(projectKey())).operation;
  assert.equal(operation?.kind, "save", "the panel is saving");
  const saved = {...snapshot, settings: {...snapshot.settings, generation: 8, monitoring: {intervalMinutes: 12, activityThreshold: 10}}};
  post.release(json({status: "saved", message: "Supervisor settings saved.", snapshot: saved}));
  const view = await until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, "saved");
  const posts = sent.filter(isPost("/api/guidance/project-supervisor"));
  assert.equal(posts.length, 1, "a second click while saving sends nothing");
  assert.equal((posts[0]!.body as ProjectSupervisorSaveInput).expectedGeneration, 7, "the save carries the generation the draft was edited against");
  assert.deepEqual(view.message, {scope: scopeA(), text: "Supervisor settings saved.", alert: false});
  assert.equal(view.blocked, false);
  assert.equal(view.snapshot?.settings.generation, 8);
  const draft = registry.get(ps.projectSupervisorDraft(projectKey()));
  assert.equal(draft?.expectedGeneration, 8);
  assert.deepEqual(draft?.monitoringValue, draft?.monitoringBaseline, "a verified save clears the draft");
  // writing the finished operation again replays nothing and applies nothing
  const key = {scope: scopeA(), operationId: operation!.operationId};
  registry.set(ps.saveSupervisorSettings(core.scopeKey(key.scope, key.operationId)), {projectKey: projectKey(), key, input: saveInput(7)});
  assert.equal(sent.filter(isPost("/api/guidance/project-supervisor")).length, 1);
  registry.dispose();
});

it("an unconfirmed save keeps the draft and blocks until a read, a refused save keeps it editable, and conflicts keep edits against the latest generation", {timeout: 10_000}, async () => {
  for (const [label, status, csrf, blocked, text] of [
    ["500", 500, 200, true, "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again."],
    ["403 refreshed", 403, 200, false, "Session refreshed. Your Supervisor change was not performed; review the state and try again."],
  ] as const) {
    const registry = AtomRegistry.make();
    sent.length = 0;
    showSnapshot(registry);
    const before = registry.get(ps.projectSupervisorDraft(projectKey()));
    reply = async request => request.path === "/api/csrf" ? json({csrf: "fresh"}, csrf) : json({message: "no"}, status);
    ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
    const view = await until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, label);
    assert.equal(view.blocked, blocked, label);
    assert.deepEqual(view.message, {scope: scopeA(), text, alert: blocked}, label);
    assert.deepEqual(registry.get(ps.projectSupervisorDraft(projectKey())), before, `${label}: the draft is kept`);
    assert.equal(sent.filter(isPost("/api/guidance/project-supervisor")).length, 1, `${label}: never replayed`);
    registry.dispose();
  }

  const draft = {...ps.mergeLoadedDraft(null, "project", snapshot).draft, monitoringValue: {intervalMinutes: "12", activityThreshold: "10"}};
  const view = {scope: "s", snapshot, readAt: 1, message: null, blocked: false, operation: null, chat: null, chatMessage: null};
  const newer = {...snapshot, settings: {...snapshot.settings, generation: 9}};
  const conflict = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "conflict", message: "Settings changed elsewhere.", snapshot: newer}));
  assert.deepEqual(conflict.draft?.monitoringValue, draft.monitoringValue, "a conflict keeps the edits");
  assert.equal(conflict.draft?.expectedGeneration, 9, "and moves them to the latest generation");
  assert.deepEqual([conflict.view.blocked, conflict.view.message?.text], [false, "Settings changed elsewhere."]);
  const blind = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "conflict", message: "Settings changed elsewhere.", snapshot: null}));
  assert.deepEqual([blind.view.blocked, blind.view.message?.text], [true, "Settings changed elsewhere. Refresh Supervisor status before trying again."]);
  const unread = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "saved", message: "Saved.", snapshot: null}));
  assert.deepEqual([unread.view.blocked, unread.view.message?.text], [true, "Saved. Refresh Supervisor status before making another change."]);
  const uncertain = ps.settleSave({view, draft}, "s", saveInput(7), Result.succeed({status: "uncertain", message: "Outcome unknown.", snapshot: null}));
  assert.deepEqual([uncertain.view.blocked, uncertain.view.message?.alert, uncertain.draft], [true, true, draft]);
  assert.equal(ps.settleRead(uncertain, "project", "s", {snapshot: newer, readAt: 2}, true).view.blocked, false, "only a read lifts the block");
});

it("a settings outcome that arrives after another chat was selected is dropped", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  showSnapshot(registry);
  const before = registry.get(ps.projectSupervisorDraft(projectKey()));
  const post = pending();
  reply = async () => {post.arrive();return post.response;};
  ps.startSettingsChange(registry, projectKey(), scopeA(), {kind: "save", input: saveInput(7)});
  await post.reached;
  registry.update(ps.projectSupervisorView(projectKey()), view => ({...view, scope: core.scopeKey("project", "other-thread")}));
  post.release(json({status: "saved", message: "Saved.", snapshot: {...snapshot, settings: {...snapshot.settings, generation: 8}}}));
  const view = await until(registry, ps.projectSupervisorView(projectKey()), value => value.operation === null, "dropped");
  assert.equal(view.message, null);
  assert.equal(view.snapshot?.settings.generation, 7);
  assert.deepEqual(registry.get(ps.projectSupervisorDraft(projectKey())), before);
  registry.dispose();
});

it("a chat Stop is admitted once, confirmed by a follow-up read for its own project and chat, and dropped for a chat selected afterwards", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  showSnapshot(registry);
  const stopped = {...snapshot, chatSupervision: {...snapshot.chatSupervision!, stopped: true, policyGeneration: 5, stoppedBy: "ui" as const, stoppedAt: 2}};
  reply = async request => isRead(request) ? json(stopped) : json({status: "saved", message: "Supervision is stopped for this chat.", snapshot: null});
  const input = {projectId: "project", mainThreadId: "task-thread", enabled: false, policyGeneration: 4};
  ps.startChatSupervisionChange(registry, projectKey(), scopeA(), input);
  ps.startChatSupervisionChange(registry, projectKey(), scopeA(), input);
  const view = await until(registry, ps.projectSupervisorView(projectKey()), value => value.chat === null, "confirmed");
  assert.deepEqual(sent.map(request => [request.method, request.path]), [["POST", "/api/guidance/project-supervisor/chat-supervision"], ["GET", "/api/guidance/project-supervisor"]]);
  assert.deepEqual(sent[0]!.body, input);
  assert.deepEqual([sent[1]!.query.get("projectId"), sent[1]!.query.get("mainThreadId")], ["project", "task-thread"], "the confirming read is for the same chat");
  assert.equal(view.snapshot?.chatSupervision?.stopped, true);
  assert.deepEqual(view.chatMessage, {scope: scopeA(), text: "Supervision is stopped for this chat."});

  sent.length = 0;
  const post = pending();
  reply = async request => {
    if (isRead(request)) return json(snapshot);
    post.arrive();
    return post.response;
  };
  ps.startChatSupervisionChange(registry, projectKey(), scopeA(), {...input, enabled: true, policyGeneration: 5});
  await post.reached;
  registry.update(ps.projectSupervisorView(projectKey()), current => ({...current, scope: core.scopeKey("project", "other-thread")}));
  post.release(json({status: "saved", message: "Supervision is enabled for this chat.", snapshot: null}));
  const late = await until(registry, ps.projectSupervisorView(projectKey()), value => value.chat === null, "dropped");
  assert.equal(late.chatMessage, null, "a late outcome never replaces another chat's view");
  assert.deepEqual(sent.map(request => request.method), ["POST"], "no confirming read for a chat that is no longer selected");
  registry.dispose();
});

effectIt.effect("the read that confirms a chat change gives up after 10 s and aborts its request", () => Effect.gen(function* () {
  sent.length = 0;
  const request = pending();
  reply = async sentRequest => {
    request.arrive();
    return new Promise<Response>((_resolve, reject) => sentRequest.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const registry = AtomRegistry.make();
  const fiber = yield* Effect.forkChild(Effect.exit(ps.chatSupervisionConfirmRead("project", "task-thread").pipe(Effect.provide(registry.get(core.uiRuntime.layer)))));
  yield* Effect.promise(() => request.reached);
  yield* TestClock.adjust("9999 millis");
  assert.equal(fiber.pollUnsafe(), undefined, "still waiting before 10 s");
  yield* TestClock.adjust("1 millis");
  const exit = yield* Fiber.join(fiber);
  assert.ok(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof Cause.TimeoutError);
  assert.equal(sent[0]?.signal?.aborted, true);
  request.release(json({}));
  registry.dispose();
}), {timeout: 10_000});

it("the chat poll reads nothing when mounted, re-reads on each refresh and replaces only the chat state; it is not mounted while a change is in flight", {timeout: 10_000}, async () => {
  const idle = {scope: scopeA(), snapshot, readAt: 1, message: null, blocked: false, operation: null, chat: null, chatMessage: null};
  const panel = {projectId: "project", threadId: "task-thread", connected: true, epoch: 0};
  assert.deepEqual(ps.chatPollScope(idle, panel), {projectId: "project", mainThreadId: "task-thread", epoch: 0});
  assert.equal(ps.chatPollScope({...idle, operation: {kind: "save", scope: scopeA(), operationId: "save-1"}}, panel), null, "no poll while saving");
  assert.equal(ps.chatPollScope({...idle, chat: {scope: scopeA(), operationId: "chat-1"}}, panel), null, "no poll while changing chat supervision");
  assert.equal(ps.chatPollScope(idle, {...panel, connected: false}), null);
  assert.equal(ps.chatPollScope(idle, {...panel, threadId: undefined}), null);

  const registry = AtomRegistry.make();
  sent.length = 0;
  const stopped = {...snapshot, message: "a newer message", chatSupervision: {...snapshot.chatSupervision!, stopped: true, stoppedBy: "relay" as const, stoppedAt: 3}};
  reply = async () => json(stopped);
  const scope = {environmentId: null, projectId: "project", mainThreadId: "task-thread", epoch: 0};
  const stop = registry.subscribe(ps.chatSupervisionPoll(scope), () => undefined, {immediate: true});
  await until(registry, ps.chatSupervisionRead(scope), value => AsyncResult.isSuccess(value) && !value.waiting, "mounted");
  assert.equal(sent.length, 0, "mounting reads nothing");
  registry.refresh(ps.chatSupervisionRead(scope));
  const polled = await until(registry, ps.chatSupervisionRead(scope), value => AsyncResult.isSuccess(value) && !value.waiting && value.value._tag === "Some", "polled");
  assert.equal(sent.length, 1);
  const read = AsyncResult.isSuccess(polled) && polled.value._tag === "Some" ? polled.value.value : snapshot;
  const next = ps.settlePoll(idle, scopeA(), read);
  assert.equal(next.snapshot?.chatSupervision?.stopped, true);
  assert.equal(next.snapshot?.message, snapshot.message, "only the chat supervision state is replaced");
  assert.equal(ps.settlePoll({...idle, operation: {kind: "save", scope: scopeA(), operationId: "save-2"}}, scopeA(), read).snapshot, snapshot);
  stop();
  registry.dispose();
});

const page = (workflowOffset: number, lineageOffset: number, status: WorkflowProgressSnapshot["status"] = "ok"): WorkflowProgressSnapshot => ({
  status, message: status === "ok" ? null : "Workflow data is not available for this page.", projectId: "project", mainThreadId: "task-thread", observedAt: 1,
  scope: null, incompatibleWorkflows: [], workflows: [], workflowOffset, workflowHasMore: true, lineageOffset, lineageHasMore: false,
});

it("live progress appends Load more pages, re-reads the loaded pages in order and keeps the shown pages when a refresh fails or comes back incomplete", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  let mode: "ok" | "fail" | "incomplete" = "ok";
  reply = async request => {
    const workflowOffset = Number(request.query.get("workflowOffset"));
    const lineageOffset = Number(request.query.get("lineageOffset"));
    if (mode === "fail") return json({message: "unavailable"}, 500);
    return json(page(workflowOffset, lineageOffset, mode === "incomplete" ? "unavailable" : "ok"));
  };
  const scope = {environmentId: null, projectId: "project", mainThreadId: "task-thread", bindingThreadId: null, bindingGeneration: null, epoch: 0};
  const read = ps.workflowProgressRead(scope);
  const settled = (predicate: (state: {pages: readonly WorkflowProgressSnapshot[]; error: string | null}) => boolean, label: string) =>
    until(registry, read, value => AsyncResult.isSuccess(value) && !value.waiting && predicate(value.value), label)
      .then(value => AsyncResult.isSuccess(value) ? value.value : assert.fail(label));
  const stop = registry.subscribe(read, () => undefined, {immediate: true});
  const offsets = () => sent.map(request => request.query.get("workflowOffset"));
  const first = await settled(state => state.pages.length === 1, "first page");
  assert.deepEqual(offsets(), ["0"]);
  assert.equal(first.error, null);

  sent.length = 0;
  registry.update(ps.workflowProgressMore(scope), current => ({seq: current.seq + 1, page: {workflowOffset: 20, lineageOffset: 0}}));
  const two = await settled(state => state.pages.length === 2, "load more");
  assert.deepEqual(offsets(), ["20"], "load more reads only the next page");

  sent.length = 0;
  mode = "fail";
  registry.refresh(read);
  const failed = await settled(state => state.error !== null, "failed refresh");
  assert.equal(failed.error, "Progress could not be refreshed. The last successful snapshot is retained.");
  assert.deepEqual(failed.pages, two.pages, "a failed refresh keeps the shown pages");

  sent.length = 0;
  mode = "incomplete";
  registry.refresh(read);
  const incomplete = await settled(state => state.error === "Workflow data is not available for this page.", "incomplete refresh");
  assert.deepEqual(incomplete.pages, two.pages, "an incomplete refresh keeps the shown pages");
  assert.deepEqual(offsets(), ["0"], "the refresh stops after the first page that is not ok");

  sent.length = 0;
  mode = "ok";
  registry.refresh(read);
  const refreshed = await settled(state => state.error === null, "refresh");
  assert.deepEqual(offsets(), ["0", "20"], "a refresh re-reads the loaded pages in order");
  assert.equal(refreshed.pages.length, 2);

  mode = "fail";
  registry.update(ps.workflowProgressMore(scope), current => ({seq: current.seq + 1, page: {workflowOffset: 40, lineageOffset: 0}}));
  const more = await settled(state => state.error !== null, "failed load more");
  assert.equal(more.error, "The next progress page could not be loaded. The last successful snapshot is retained.");
  assert.deepEqual(more.pages, refreshed.pages);
  stop();

  const other = ps.workflowProgressRead({...scope, mainThreadId: "other-thread"});
  const stopOther = registry.subscribe(other, () => undefined, {immediate: true});
  const unread = await until(registry, other, value => AsyncResult.isSuccess(value) && !value.waiting, "first read failure");
  assert.deepEqual(AsyncResult.isSuccess(unread) ? [unread.value.pages, unread.value.error] : [], [[], "Progress could not be loaded for this main conversation."]);
  stopOther();
  registry.dispose();
});

it("a new scope revision interrupts the snapshot read of the previous one and aborts its request", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  const first = pending();
  let aborted!: Promise<void>;
  reply = async request => {
    if (sent.length > 1) return json(snapshot);
    aborted = new Promise(resolve => request.signal?.addEventListener("abort", () => resolve()));
    first.arrive();
    return first.response;
  };
  const previous = ps.projectSupervisorRead({environmentId: null, projectId: "project", mainThreadId: "task-thread", revision: 0, epoch: 0});
  const stopPrevious = registry.subscribe(previous, () => undefined, {immediate: true});
  await first.reached;
  stopPrevious();
  const next = ps.projectSupervisorRead({environmentId: null, projectId: "project", mainThreadId: "task-thread", revision: 1, epoch: 0});
  const stopNext = registry.subscribe(next, () => undefined, {immediate: true});
  const read = await until(registry, next, value => AsyncResult.isSuccess(value) && !value.waiting, "next revision");
  assert.equal(AsyncResult.isSuccess(read) ? read.value.snapshot.projectId : null, "project");
  await aborted;
  assert.equal(sent[0]?.signal?.aborted, true, "the previous read was interrupted");
  assert.ok(AsyncResult.isInitial(registry.get(previous)) || !AsyncResult.isSuccess(registry.get(previous)), "the previous read never settles as a success");
  first.release(json(snapshot));
  stopNext();
  registry.dispose();
});
