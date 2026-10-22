import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { it, type TestContext } from "vitest";
import { ProjectSupervisorSaveResult, ProjectSupervisorSnapshot, type ProjectSupervisorChatSupervisionInput, type ProjectSupervisorRetryInput, type ProjectSupervisorSaveInput } from "../src/project-supervisor-contract.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import { getCsrfToken } from "../ui/src/access.js";
import { ProjectConfigRequestError, saveProjectConfiguration } from "../ui/src/project-definitions-api.js";
import { loadProjectSupervisor, ProjectSupervisorRequestError, retryProjectSupervisor, saveProjectSupervisor, setChatSupervision } from "../ui/src/project-supervisor-api.js";
import { defer, readCsrf, signIn } from "./support/c3b-http.js";
import { fakeSupervision, supervisorSnapshot } from "./support/c3b-project-supervisor.js";
import { startUi } from "./support/c3b-ui.js";
import { installPageLocation, runUi } from "./support/ui-run.js";

type Golden = {snapshot: unknown; saveResult: unknown; retryResult: unknown};
const golden = JSON.parse(readFileSync(new URL("./support/c3b-project-supervisor.golden.json", import.meta.url), "utf8")) as Golden;

const saveInput: ProjectSupervisorSaveInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7,
  modelSelection: {instanceId: "provider-one", model: "steady-model", options: []}};
const retryInput: ProjectSupervisorRetryInput = {projectId: "project", mainThreadId: "task-thread", expectedGeneration: 7, threadId: "supervisor-thread",
  bindingGeneration: 7, action: "retry"};
const chatInput: ProjectSupervisorChatSupervisionInput = {projectId: "project", mainThreadId: "task-thread", enabled: false, policyGeneration: 4};
const configInput: ProjectConfigSave = {projectId: "project", threadId: null, expectedRevision: "a".repeat(64), config: {workflows: [], steps: []}};

it("CT-PSC-01: the baseline server's snapshot and save results match the golden JSON and survive decode and re-encode unchanged; extra payload fields are stripped", {timeout: 10_000}, async t => {
  const {supervision, calls} = fakeSupervision();
  const {origin, directory} = await startUi(t, {supervision});
  const session = await signIn(origin, directory);
  const csrf = await readCsrf(origin, session);
  const headers = {"x-supervisor-session": session};
  const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) =>
    JSON.parse(JSON.stringify(Schema.encodeUnknownSync(schema as never)(Schema.decodeUnknownSync(schema as never)(value)))) as unknown;

  const loaded = await fetch(origin + "/api/guidance/project-supervisor?projectId=project&mainThreadId=task-thread", {headers});
  assert.equal(loaded.status, 200);
  const snapshot = await loaded.json();
  assert.deepEqual(snapshot, golden.snapshot);
  assert.deepEqual(roundTrip(ProjectSupervisorSnapshot, snapshot), golden.snapshot);
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(supervisorSnapshot)), "the server encodes the handler value unchanged");

  const post = async (path: string, payload: unknown) => {
    const response = await fetch(origin + path, {method: "POST", body: JSON.stringify(payload),
      headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf}});
    return [response.status, await response.json()];
  };
  const [saveStatus, saved] = await post("/api/guidance/project-supervisor", saveInput);
  assert.equal(saveStatus, 200);
  assert.deepEqual(saved, golden.saveResult);
  assert.deepEqual(roundTrip(ProjectSupervisorSaveResult, saved), golden.saveResult);
  const [retryStatus, retried] = await post("/api/guidance/project-supervisor/retry", retryInput);
  assert.equal(retryStatus, 200);
  assert.deepEqual(retried, golden.retryResult);
  assert.deepEqual(roundTrip(ProjectSupervisorSaveResult, retried), golden.retryResult);

  // default HttpApi parse options drop unknown fields at every level before the handler runs
  assert.deepEqual(await post("/api/guidance/project-supervisor", {...saveInput, unexpected: true,
    modelSelection: {...saveInput.modelSelection, extra: "x"}}), [200, golden.saveResult]);
  assert.deepEqual(await post("/api/guidance/project-supervisor/retry", {...retryInput, unexpected: true}), [200, golden.retryResult]);
  assert.deepEqual(await post("/api/guidance/project-supervisor/chat-supervision", {...chatInput, unexpected: true}), [200, golden.retryResult]);
  assert.deepEqual(calls.saves, [saveInput, saveInput]);
  assert.deepEqual(calls.retries, [retryInput, retryInput]);
  assert.deepEqual(calls.chats, [chatInput]);
});

// a browser storage, window and fetch installed on globalThis for the exported fetch helpers, restored afterwards
const installBrowser = (t: TestContext) => {
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);},
    removeItem: (key: string) => {values.delete(key);}};
  const window = new EventTarget();
  const originals = new Map(["localStorage", "window", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  install("localStorage", storage);
  install("window", window);
  defer(t, installPageLocation());
  defer(t, () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {values, window, setFetch: (fetch: (url: string, init?: RequestInit) => Promise<Response>) => install("fetch", fetch)};
};

type Reply = {status: number; body: string};
const json = (value: unknown, status = 200): Reply => ({status, body: JSON.stringify(value)});

it("CT-UI-API-01: every exported mutation helper maps 401, 403, 413, 415, 500 and malformed responses to the golden outcome text and flag without replaying", {timeout: 10_000}, async t => {
  const browser = installBrowser(t);
  let expired = 0;
  browser.window.addEventListener("supervisor-auth-required", () => {expired++;});
  const run = async (helper: () => Promise<unknown>, reply: Reply, csrf: Reply) => {
    browser.values.set("supervisor-session", "session-1");
    const requests: string[] = [];
    browser.setFetch(async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      const chosen = url === "/api/csrf" ? csrf : reply;
      return new Response(chosen.body, {status: chosen.status});
    });
    const before = expired;
    try {
      await helper();
      return {outcome: "resolved", requests};
    } catch (error) {
      const known = error instanceof ProjectSupervisorRequestError || error instanceof ProjectConfigRequestError;
      return {outcome: known ? [error.message, error.definitelyNotSaved] : "not a request error", requests,
        session: browser.values.get("supervisor-session") ?? null, expired: expired - before};
    }
  };
  const refreshed = json({csrf: "refreshed-csrf"});
  const refreshFailed = json({message: "Sign in to Supervisor."}, 401);
  const helpers = {
    saveProjectSupervisor: {call: () => runUi(saveProjectSupervisor(saveInput)), path: "/api/guidance/project-supervisor"},
    retryProjectSupervisor: {call: () => runUi(retryProjectSupervisor(retryInput)), path: "/api/guidance/project-supervisor/retry"},
    setChatSupervision: {call: () => runUi(setChatSupervision(chatInput)), path: "/api/guidance/project-supervisor/chat-supervision"},
    saveProjectConfiguration: {call: () => saveProjectConfiguration(configInput, "prop-csrf"), path: "/api/guidance/project-configuration"},
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
    const matrix: Array<[string, Reply, Reply, unknown]> = [
      ["401 refreshed", json({message: "Sign in to Supervisor."}, 401), refreshed,
        {outcome: [text.refreshed, true], requests: withRefresh, session: "session-1", expired: 0}],
      ["401 refresh failed", json({message: "Sign in to Supervisor."}, 401), refreshFailed,
        {outcome: [text.refreshFailed, true], requests: withRefresh, session: null, expired: 1}],
      ["403 refreshed", json({message: "Refresh the local dashboard before changing settings."}, 403), refreshed,
        {outcome: [text.refreshed, true], requests: withRefresh, session: "session-1", expired: 0}],
      ["403 refresh failed", json({message: "Refresh the local dashboard before changing settings."}, 403), refreshFailed,
        {outcome: [text.refreshFailed, true], requests: withRefresh, session: null, expired: 1}],
      ["413", json({message: "The request payload is too large. Reduce its size before retrying."}, 413), refreshed,
        {outcome: [text.tooLarge, true], requests: [post], session: "session-1", expired: 0}],
      ["415", json({message: "Use JSON for supervisor mutations."}, 415), refreshed,
        {outcome: [text.format, true], requests: [post], session: "session-1", expired: 0}],
      ["500", json({message: "Supervisor operation unavailable."}, 500), refreshed,
        {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
      ["400 UiError", json({_tag: "UiError", message: "Reload first."}, 400), refreshed,
        {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
      // the config helper lets the raw parse or decode error escape; the editor then treats the save as unconfirmed
      ["malformed JSON", {status: 200, body: "{\"status\":"}, refreshed, name === "saveProjectConfiguration"
        ? {outcome: "not a request error", requests: [post], session: "session-1", expired: 0}
        : {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
      ["undecodable JSON", json({status: "saved", message: 1}), refreshed, name === "saveProjectConfiguration"
        ? {outcome: "not a request error", requests: [post], session: "session-1", expired: 0}
        : {outcome: [text.unknown, false], requests: [post], session: "session-1", expired: 0}],
    ];
    for (const [label, reply, csrf, expected] of matrix) assert.deepEqual(await run(helper.call, reply, csrf), expected, `${name} ${label}`);
  }
  assert.equal(getCsrfToken(), "", "a failed refresh clears the cached CSRF token");
});

it("CT-PSC-02: an undecodable snapshot or save response never resolves as success; a save reports an unknown outcome", {timeout: 10_000}, async t => {
  const browser = installBrowser(t);
  browser.values.set("supervisor-session", "session-1");
  const respond = (body: unknown) => browser.setFetch(async () => new Response(JSON.stringify(body), {status: 200}));
  const unknown = (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved &&
    error.message === "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.";

  respond({...supervisorSnapshot, tasks: [{...supervisorSnapshot.tasks[0], status: "unknown-status"}]});
  const loadFailure = (error: unknown) => !(error instanceof ProjectSupervisorRequestError);
  await assert.rejects(runUi(loadProjectSupervisor("project", "task-thread"), AbortSignal.timeout(5_000)), loadFailure);
  respond({...supervisorSnapshot, binding: {...supervisorSnapshot.binding, generation: "7"}});
  await assert.rejects(runUi(loadProjectSupervisor("project", "task-thread"), AbortSignal.timeout(5_000)), loadFailure);

  // a saved status whose snapshot does not decode is not reported as saved
  const brokenSnapshot = {...supervisorSnapshot, models: [{instanceId: "provider-one"}]};
  for (const helper of [() => runUi(saveProjectSupervisor(saveInput)), () => runUi(retryProjectSupervisor(retryInput)), () => runUi(setChatSupervision(chatInput))]) {
    respond({status: "saved", message: "Saved.", snapshot: brokenSnapshot});
    await assert.rejects(helper(), unknown);
    respond({status: "saved", message: "Saved."});
    await assert.rejects(helper(), unknown);
  }
  // the same decodable response is accepted, so the rejection above is the decode failure
  respond({status: "saved", message: "Saved.", snapshot: supervisorSnapshot});
  assert.equal((await runUi(saveProjectSupervisor(saveInput))).status, "saved");
});
