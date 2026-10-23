import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import { ProjectSupervisorSaveResult, ProjectSupervisorSnapshot, type ProjectSupervisorChatSupervisionInput, type ProjectSupervisorRetryInput, type ProjectSupervisorSaveInput } from "../src/project-supervisor-contract.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import { SessionAccess } from "../ui/src/access.js";
import type { ApiClient } from "../ui/src/api.js";
import { ProjectConfigRequestError, saveProjectConfiguration } from "../ui/src/project-definitions-api.js";
import { loadProjectSupervisor, ProjectSupervisorRequestError, retryProjectSupervisor, saveProjectSupervisor, setChatSupervision } from "../ui/src/project-supervisor-api.js";
import { fakeSupervision, supervisorSnapshot } from "./support/c3b-project-supervisor.js";
import { dashboard, readCsrf, signIn } from "./support/g6-dashboard.js";
import { installGlobal, locationLayer, pageLayer, rejects } from "./support/g6-page.js";

type Golden = {snapshot: unknown; saveResult: unknown; retryResult: unknown};
const golden = JSON.parse(readFileSync(new URL("./support/c3b-project-supervisor.golden.json", import.meta.url), "utf8")) as Golden;

const saveInput: ProjectSupervisorSaveInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7,
  modelSelection: {instanceId: "provider-one", model: "steady-model", options: []}};
const retryInput: ProjectSupervisorRetryInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7, threadId: "supervisor-thread",
  bindingGeneration: 7, action: "retry"};
const chatInput: ProjectSupervisorChatSupervisionInput = {projectId: "project", mainThreadId: "task-thread", enabled: false, policyGeneration: 4};
const configInput: ProjectConfigSave = {projectId: "project", threadId: null, expectedRevision: "a".repeat(64), config: {workflows: [], steps: []}};

// real loopback sockets to the dashboard server: it.live
it.live("CT-PSC-01: the baseline server's snapshot and save results match the golden JSON and survive decode and re-encode unchanged; extra payload fields are stripped", () => Effect.gen(function* () {
  const {supervision, calls} = fakeSupervision();
  const {origin, directory} = yield* dashboard({supervision});
  const session = yield* signIn(origin, directory);
  const csrf = yield* readCsrf(origin, session);
  const headers = {"x-supervisor-session": session};
  const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) =>
    JSON.parse(JSON.stringify(Schema.encodeUnknownSync(schema as never)(Schema.decodeUnknownSync(schema as never)(value)))) as unknown;
  const client = yield* HttpClient.HttpClient;

  const loaded = yield* client.get(origin + "/api/guidance/project-supervisor?projectId=project&mainThreadId=task-thread", {headers});
  assert.equal(loaded.status, 200);
  const snapshot = yield* loaded.json;
  assert.deepEqual(snapshot, golden.snapshot);
  assert.deepEqual(roundTrip(ProjectSupervisorSnapshot, snapshot), golden.snapshot);
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(supervisorSnapshot)), "the server encodes the handler value unchanged");

  const post = (path: string, payload: unknown) => Effect.gen(function* () {
    const response = yield* client.post(origin + path, {body: HttpBody.text(JSON.stringify(payload), "application/json"),
      headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}});
    return [response.status, yield* response.json];
  });
  const [saveStatus, saved] = yield* post("/api/guidance/project-supervisor", saveInput);
  assert.equal(saveStatus, 200);
  assert.deepEqual(saved, golden.saveResult);
  assert.deepEqual(roundTrip(ProjectSupervisorSaveResult, saved), golden.saveResult);
  const [retryStatus, retried] = yield* post("/api/guidance/project-supervisor/retry", retryInput);
  assert.equal(retryStatus, 200);
  assert.deepEqual(retried, golden.retryResult);
  assert.deepEqual(roundTrip(ProjectSupervisorSaveResult, retried), golden.retryResult);

  // default HttpApi parse options drop unknown fields at every level before the handler runs
  assert.deepEqual(yield* post("/api/guidance/project-supervisor", {...saveInput, unexpected: true,
    modelSelection: {...saveInput.modelSelection, extra: "x"}}), [200, golden.saveResult]);
  assert.deepEqual(yield* post("/api/guidance/project-supervisor/retry", {...retryInput, unexpected: true}), [200, golden.retryResult]);
  assert.deepEqual(yield* post("/api/guidance/project-supervisor/chat-supervision", {...chatInput, unexpected: true}), [200, golden.retryResult]);
  assert.deepEqual(calls.saves, [saveInput, saveInput]);
  assert.deepEqual(calls.retries, [retryInput, retryInput]);
  assert.deepEqual(calls.chats, [chatInput]);
}).pipe(Effect.provide(FetchHttpClient.layer)), {timeout: 10_000});

// a browser storage, window, location and fetch installed on globalThis for the client effects, restored when the layer
// closes; the page of each test is built over it, so its session access listens to this window
class Browser extends Context.Service<Browser, {
  readonly values: Map<string, string>;
  readonly window: EventTarget;
  readonly setFetch: (fetch: (url: string, init?: RequestInit) => Promise<Response>) => void;
}>()("test/project-supervisor-ui.characterization/Browser") {
  static readonly layer = Layer.effect(Browser, Effect.gen(function* () {
    const values = new Map<string, string>();
    const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);},
      removeItem: (key: string) => {values.delete(key);}};
    const window = new EventTarget();
    yield* installGlobal("fetch", globalThis.fetch);
    yield* installGlobal("window", window);
    yield* installGlobal("localStorage", storage);
    const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
    return {values, window, setFetch: (fetch: (url: string, init?: RequestInit) => Promise<Response>) => install("fetch", fetch)};
  })).pipe(Layer.provideMerge(locationLayer()));
}
// the page of one test over its browser
const browserPage = pageLayer.pipe(Layer.provideMerge(Browser.layer));

type Reply = {status: number; body: string};
const json = (value: unknown, status = 200): Reply => ({status, body: JSON.stringify(value)});

// a stubbed browser fetch and the page's own session access, no time: it.effect
it.effect("CT-UI-API-01: every exported mutation helper maps 401, 403, 413, 415, 500 and malformed responses to the golden outcome text and flag without replaying", () => Effect.gen(function* () {
  const browser = yield* Browser;
  const access = yield* SessionAccess;
  let expired = 0;
  browser.window.addEventListener("supervisor-auth-required", () => {expired++;});
  // sent: the session the request carries (null: none) and the CSRF token cached before it is sent ("" when none)
  const run = (helper: Effect.Effect<unknown, unknown, ApiClient | SessionAccess>, reply: Reply, csrf: Reply, sent: {session: string | null; token: string}) => Effect.gen(function* () {
    browser.values.set("supervisor-session", "session-1");
    yield* access.clear("session-1");
    if (sent.session !== null) browser.values.set("supervisor-session", sent.session);
    if (sent.token !== "") {
      browser.setFetch(async () => new Response(JSON.stringify({csrf: sent.token}), {status: 200}));
      assert.equal(yield* access.load, true);
    }
    const requests: string[] = [];
    browser.setFetch(async (url, init) => {
      const path = new URL(String(url), "http://supervisor.test").pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      const chosen = path === "/api/csrf" ? csrf : reply;
      return new Response(chosen.body, {status: chosen.status});
    });
    const before = expired;
    const exit = yield* Effect.exit(helper);
    if (Exit.isSuccess(exit)) return {outcome: "resolved", requests};
    // the error the helper's baseline promise rejected with
    const error = Cause.squash(exit.cause);
    const known = error instanceof ProjectSupervisorRequestError || error instanceof ProjectConfigRequestError;
    return {outcome: known ? [error.message, error.definitelyNotSaved] : "not a request error", requests,
      session: browser.values.get("supervisor-session") ?? null, expired: expired - before};
  });
  const refreshed = json({csrf: "refreshed-csrf"});
  const refreshFailed = json({message: "Sign in to Supervisor."}, 401);
  const helpers = {
    saveProjectSupervisor: {call: saveProjectSupervisor(saveInput), path: "/api/guidance/project-supervisor"},
    retryProjectSupervisor: {call: retryProjectSupervisor(retryInput), path: "/api/guidance/project-supervisor/retry"},
    setChatSupervision: {call: setChatSupervision(chatInput), path: "/api/guidance/project-supervisor/chat-supervision"},
    saveProjectConfiguration: {call: saveProjectConfiguration(configInput), path: "/api/guidance/project-configuration"},
  };
  const supervisorText = {
    refreshed: "Session refreshed. Your Supervisor change was not performed; review the state and try again.",
    refreshFailed: "Your Supervisor change was not performed. Session refresh failed; reconnect and try again.",
    tooLarge: "Your Supervisor change was not performed because the request is too large.",
    format: "Your Supervisor change was not performed because the server rejected the request format.",
    unknown: "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.",
  };
  const configText = {
    refreshed: "Session refreshed. Your draft was not saved; review it and save again.",
    refreshFailed: "Your draft was not saved. Session refresh failed; reconnect and save again.",
    tooLarge: "Your draft was not saved. The request is too large; shorten the project configuration before saving again.",
    format: "Your draft was not saved. The server rejected the request format.",
    unknown: "The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying.",
  };
  for (const [name, helper] of Object.entries(helpers)) {
    const text = name === "saveProjectConfiguration" ? configText : supervisorText;
    const post = `POST ${helper.path}`;
    const withRefresh = [post, "GET /api/csrf"];
    const signedIn = {session: "session-1", token: ""};
    const unauthorized = json({message: "Sign in to Supervisor."}, 401);
    const forbidden = json({message: "Refresh the local dashboard before changing settings."}, 403);
    // fetch shows only the last attempt; a browser resend repeats the original headers after the session or the server
    // process (whose CSRF token is per process) may have ended. A refusal is a definite not-performed only when its check
    // refuses those headers on every attempt. target change (approved, story03): the baseline reported every 401 and 403
    // as not performed; a 401 for a sent session and a 403 for a token the process no longer issues are now unknown
    const matrix: Array<[string, Reply, Reply, {session: string | null; token: string}, unknown]> = [
      ["401 for a session, refreshed (target change)", unauthorized, refreshed, signedIn,
        {outcome: [text.unknown, false], requests: withRefresh, session: "session-1", expired: 0}],
      ["401 for a session, refresh failed (target change)", unauthorized, refreshFailed, signedIn,
        {outcome: [text.unknown, false], requests: withRefresh, session: null, expired: 1}],
      ["401 without a session", unauthorized, refreshFailed, {session: null, token: ""},
        {outcome: [text.refreshFailed, true], requests: withRefresh, session: null, expired: 1}],
      ["403 without a token, refreshed", forbidden, refreshed, signedIn,
        {outcome: [text.refreshed, true], requests: withRefresh, session: "session-1", expired: 0}],
      ["403 without a token, refresh failed", forbidden, refreshFailed, signedIn,
        {outcome: [text.refreshFailed, true], requests: withRefresh, session: null, expired: 1}],
      ["403 with the token the process still issues", forbidden, refreshed, {session: "session-1", token: "refreshed-csrf"},
        {outcome: [text.refreshed, true], requests: withRefresh, session: "session-1", expired: 0}],
      ["403 with a token the process no longer issues (target change)", forbidden, refreshed, {session: "session-1", token: "earlier-csrf"},
        {outcome: [text.unknown, false], requests: withRefresh, session: "session-1", expired: 0}],
      ["403 with a token, refresh failed (target change)", forbidden, refreshFailed, {session: "session-1", token: "earlier-csrf"},
        {outcome: [text.unknown, false], requests: withRefresh, session: null, expired: 1}],
      ["413", json({message: "The request payload is too large. Reduce its size before retrying."}, 413), refreshed, signedIn,
        {outcome: [text.tooLarge, true], requests: [post], session: "session-1", expired: 0}],
      ["415", json({message: "Use JSON for supervisor mutations."}, 415), refreshed, signedIn,
        {outcome: [text.format, true], requests: [post], session: "session-1", expired: 0}],
      ["500", json({message: "Supervisor operation unavailable."}, 500), refreshed, signedIn,
        {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
      ["400 UiError", json({_tag: "UiError", message: "Reload first."}, 400), refreshed, signedIn,
        {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
      ["malformed JSON", {status: 200, body: "{\"status\":"}, refreshed, signedIn,
        {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
      ["undecodable JSON", json({status: "saved", message: 1}), refreshed, signedIn,
        {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
    ];
    for (const [label, reply, csrf, sent, expected] of matrix) assert.deepEqual(yield* run(helper.call, reply, csrf, sent), expected, `${name} ${label}`);
  }
  assert.equal((yield* access.headers)["x-csrf-token"], "", "a failed refresh clears the cached CSRF token");
}).pipe(Effect.provide(browserPage)), {timeout: 10_000});

// a stubbed browser fetch, no time: it.effect
it.effect("CT-PSC-02: an undecodable snapshot or save response never resolves as success; a save reports an unknown outcome", () => Effect.gen(function* () {
  const browser = yield* Browser;
  browser.values.set("supervisor-session", "session-1");
  const respond = (body: unknown) => browser.setFetch(async () => new Response(JSON.stringify(body), {status: 200}));
  const unknown = (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved &&
    error.message === "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.";

  respond({...supervisorSnapshot, tasks: [{...supervisorSnapshot.tasks[0], status: "unknown-status"}]});
  const loadFailure = (error: unknown) => !(error instanceof ProjectSupervisorRequestError);
  yield* rejects(loadProjectSupervisor("project", "task-thread"), loadFailure);
  respond({...supervisorSnapshot, binding: {...supervisorSnapshot.binding, generation: "7"}});
  yield* rejects(loadProjectSupervisor("project", "task-thread"), loadFailure);

  // a saved status whose snapshot does not decode is not reported as saved
  const brokenSnapshot = {...supervisorSnapshot, models: [{instanceId: "provider-one"}]};
  for (const helper of [saveProjectSupervisor(saveInput), retryProjectSupervisor(retryInput), setChatSupervision(chatInput)]) {
    respond({status: "saved", message: "Saved.", snapshot: brokenSnapshot});
    yield* rejects(helper, unknown);
    respond({status: "saved", message: "Saved."});
    yield* rejects(helper, unknown);
  }
  // the same decodable response is accepted, so the rejection above is the decode failure
  respond({status: "saved", message: "Saved.", snapshot: supervisorSnapshot});
  assert.equal((yield* saveProjectSupervisor(saveInput)).status, "saved");
}).pipe(Effect.provide(browserPage)), {timeout: 10_000});
