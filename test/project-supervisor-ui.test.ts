import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSupervisorInfo, ProjectSupervisorRetryInput, ProjectSupervisorSaveInput, SupervisorModelSelection } from "../src/project-supervisor-contract.js";
import { ProjectSupervisorView, shouldOfferNativeRetry } from "../ui/src/project-supervisor.js";
import { loadProjectSupervisor, ProjectSupervisorRequestError, retryProjectSupervisor, saveProjectSupervisor } from "../ui/src/project-supervisor-api.js";

const selection: SupervisorModelSelection = {
  instanceId: "provider-one",
  model: "steady-model",
  options: [{id: "reasoningEffort", value: "steady"}, {id: "temperature", value: "0.6"}],
};

const snapshot: ProjectSupervisorInfo = {
  projectId: "project",
  settings: {generation: 7, modelSelection: selection, pending: true},
  binding: {projectId: "project", threadId: "exact-thread-123", generation: 7, enabledAt: 1, state: "ready"},
  modelSelection: {instanceId: "provider-two", model: "quick-model", options: [{id: "thinking", value: true}]},
  models: [
    {instanceId: "provider-one", model: "steady-model", name: "Steady", providerName: "Provider One", available: true, options: [
      {id: "reasoningEffort", label: "Reasoning", choices: [{value: "steady", label: "Steady"}, {value: "quick", label: "Quick"}], defaultValue: "steady"},
      {id: "temperature", label: "Temperature", choices: [{value: "0.2", label: "0.2"}, {value: "0.6", label: "0.6"}], defaultValue: "0.6"},
    ]},
    {instanceId: "provider-two", model: "quick-model", name: "Quick", providerName: "Provider Two", available: false, options: [
      {id: "thinking", label: "Thinking", choices: [{value: true, label: "Enabled"}, {value: false, label: "Disabled"}], defaultValue: true},
    ]},
  ],
  available: true,
  message: "T3 reports the selected model.",
  tasks: [{threadId: "task-thread", projectId: "project", sourceRunId: "run-1", sourceMessageId: "message-1", status: "inferred", objective: "<script>task</script>", reason: "The task text supports this interpretation.", updatedAt: 1}],
};

const input: ProjectSupervisorSaveInput = {projectId: "project", expectedGeneration: 7, modelSelection: selection};

test("Supervisor settings markup explains automatic conversation reuse and separates saved, current and task state", () => {
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    snapshot: {...snapshot, message: '<img src=x onerror="alert(1)">'}, selection, threadId: "task-thread", connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false, shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Bound conversation/);
  assert.match(html, /t3-thread:\/\/v1\/exact-thread-123/);
  assert.match(html, /Saving settings does not start a conversation/);
  assert.match(html, /creates the Supervisor conversation for the first task that needs it/);
  assert.match(html, /reuses that conversation for later tasks/);
  assert.match(html, /Saved Supervisor model/);
  assert.match(html, /Current model observed in T3/);
  assert.match(html, /waiting to apply the saved model selection while the Supervisor is idle/);
  assert.match(html, /Task interpretation for the selected conversation/);
  assert.match(html, /&lt;script&gt;task&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<label>Model/);
  assert.match(html, /<label>Reasoning/);
  assert.doesNotMatch(html, /<label>Temperature/);
  assert.doesNotMatch(html, /Create conversation/);
});

test("unavailable saved models remain visible and disabled while an available model can be selected", () => {
  const unavailable = snapshot.models[1]!;
  const unavailableSelection: SupervisorModelSelection = {instanceId: unavailable.instanceId, model: unavailable.model, options: [{id: "thinking", value: true}]};
  const savedSnapshot = {...snapshot, settings: {...snapshot.settings, modelSelection: unavailableSelection}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    snapshot: savedSnapshot, selection: unavailableSelection, connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: false, canSave: false, shouldOfferRetry: false, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Saved Supervisor model:<\/strong> Provider Two · Quick \(quick-model\) — unavailable/);
  assert.match(html, /Quick \(quick-model\) — unavailable/);
  assert.match(html, /disabled=""/);
});

test("an uncertain result from another project thread exposes retry only after the draft is resolved", () => {
  const uncertainTask = {...snapshot.tasks[0]!, threadId: "other-thread", status: "uncertain" as const};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    snapshot: {...snapshot, tasks: [...snapshot.tasks, uncertainTask]}, selection, threadId: "task-thread", connected: true,
    saving: false, fieldsBusy: false, blocked: false, dirty: true, canSave: true, shouldOfferRetry: true,
    retryButtonLabel: "Retry native access", canRetry: false, onSelectionChange: () => {}, onDiscard: () => {}, onRetry: () => {},
    onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Retry native access/);
  assert.match(html, /Save or discard your settings draft before retrying native access/);
  assert.match(html, /<button type="button" disabled="">Retry native access<\/button>/);
  assert.match(html, /Task interpretation for the selected conversation/);
});

test("a deleted binding has a distinct explicit replacement action and no live link to the deleted thread", () => {
  const missingSnapshot = {...snapshot, binding: {...snapshot.binding!, state: "missing" as const}};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    snapshot: missingSnapshot, selection, connected: true, saving: false, fieldsBusy: false, blocked: false,
    dirty: false, canSave: false, shouldOfferRetry: true, retryButtonLabel: "Replace deleted Supervisor conversation", canRetry: true,
    onSelectionChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /Deleted Supervisor conversation/);
  assert.match(html, /Replace deleted Supervisor conversation/);
  assert.doesNotMatch(html, /Open in T3/);
});

test("native retries are explicit for pending ready bindings and uncertain project tasks, never for a pre-task pending default", () => {
  assert.equal(shouldOfferNativeRetry(snapshot), true);
  const beforeFirstTask = {...snapshot, binding: null, settings: {...snapshot.settings, pending: true}};
  assert.equal(shouldOfferNativeRetry(beforeFirstTask), false);
  const uncertainTask = {...snapshot.tasks[0]!, threadId: "other-thread", status: "uncertain" as const};
  assert.equal(shouldOfferNativeRetry({...beforeFirstTask, tasks: [uncertainTask]}), true);
});

test("project task recovery remains visible but disabled until a bound conversation exists", () => {
  const unboundSnapshot = {...snapshot, binding: null};
  const html = renderToStaticMarkup(createElement(ProjectSupervisorView, {
    snapshot: unboundSnapshot, selection, connected: true, saving: false, fieldsBusy: false, blocked: false,
    dirty: false, canSave: false, shouldOfferRetry: true, retryButtonLabel: "Retry native access", canRetry: false,
    onSelectionChange: () => {}, onDiscard: () => {}, onRetry: () => {}, onSubmit: event => event.preventDefault(),
  }));
  assert.match(html, /No bound Supervisor conversation is available to retry yet/);
  assert.match(html, /<button type="button" disabled="">Retry native access<\/button>/);
});

test("Supervisor client encodes project targets, checks response identity and passes GET cancellation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    let seen = "";
    globalThis.fetch = async (inputValue, init) => {
      seen = String(inputValue);
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.credentials, "same-origin");
      return new Response(JSON.stringify({...snapshot, projectId: "project & one"}), {status: 200});
    };
    const loaded = await loadProjectSupervisor("project & one", controller.signal);
    assert.equal(loaded.projectId, "project & one");
    assert.equal(new URL(seen, "http://localhost").searchParams.get("projectId"), "project & one");

    globalThis.fetch = async () => new Response(JSON.stringify({...snapshot, projectId: "another-project"}), {status: 200});
    await assert.rejects(loadProjectSupervisor("project", controller.signal), /another project/);
  } finally {globalThis.fetch = original;}
});

test("a late GET cannot cross an aborted selection", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let resolveResponse: ((response: Response) => void) | undefined;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return await new Promise<Response>(resolve => {resolveResponse = resolve;});
    };
    const pending = loadProjectSupervisor("project", controller.signal);
    assert.ok(resolveResponse);
    controller.abort();
    resolveResponse!(new Response(JSON.stringify(snapshot), {status: 200}));
    await assert.rejects(pending, /another project/);
  } finally {globalThis.fetch = original;}
});

test("a save response for another project is treated as an unknown outcome", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "same-origin");
      return new Response(JSON.stringify({status: "saved", message: "Saved", snapshot: {...snapshot, projectId: "another-project"}}), {status: 200});
    };
    await assert.rejects(saveProjectSupervisor(input, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = original;}
});

test("native access retry uses its dedicated route and blocks a foreign-project response", async () => {
  const original = globalThis.fetch;
  const retryInput: ProjectSupervisorRetryInput = {projectId: "project", expectedGeneration: 7, threadId: "bound-thread", bindingGeneration: 3, action: "retry"};
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/guidance/project-supervisor/retry");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), retryInput);
      return new Response(JSON.stringify({status: "uncertain", message: "Retry needs refresh.", snapshot: {...snapshot, projectId: "another-project"}}), {status: 200});
    };
    await assert.rejects(retryProjectSupervisor(retryInput, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = original;}
});

test("deleted-conversation recovery sends an explicit replacement action and binding identity", async () => {
  const original = globalThis.fetch;
  const replaceInput: ProjectSupervisorRetryInput = {projectId: "project", expectedGeneration: 7, threadId: "deleted-thread", bindingGeneration: 4, action: "replace"};
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/guidance/project-supervisor/retry");
      assert.deepEqual(JSON.parse(String(init?.body)), replaceInput);
      return new Response(JSON.stringify({status: "saved", message: "Replaced explicitly.", snapshot}), {status: 200});
    };
    assert.equal((await retryProjectSupervisor(replaceInput, "token")).status, "saved");
  } finally {globalThis.fetch = original;}
});

test("a retry 403 refreshes the latest CSRF token without automatically repeating the native request", async () => {
  const original = globalThis.fetch;
  const retryInput: ProjectSupervisorRetryInput = {projectId: "project", expectedGeneration: 7, threadId: "bound-thread", bindingGeneration: 3, action: "retry"};
  let csrfReads = 0;
  let retryWrites = 0;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/csrf") {
        csrfReads++;
        return new Response(JSON.stringify({csrf: csrfReads === 1 ? "retry-first-token" : "retry-current-token"}), {status: 200});
      }
      retryWrites++;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-csrf-token"], retryWrites === 1 ? "retry-first-token" : "retry-current-token");
      if (retryWrites === 1) return new Response("{}", {status: 403});
      return new Response(JSON.stringify({status: "saved", message: "Retry accepted.", snapshot}), {status: 200});
    };

    const {loadAccess} = await import("../ui/src/access.js");
    assert.equal(await loadAccess(), true);
    await assert.rejects(retryProjectSupervisor(retryInput, "old-prop-token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved);
    assert.equal(retryWrites, 1);
    assert.equal(csrfReads, 2);
    assert.equal((await retryProjectSupervisor(retryInput, "old-prop-token")).status, "saved");
    assert.equal(retryWrites, 2);
    assert.equal(csrfReads, 2);
  } finally {globalThis.fetch = original;}
});

test("a 403 refreshes CSRF without retrying the POST and the next explicit save uses the latest token", async () => {
  const original = globalThis.fetch;
  let csrfReads = 0;
  let writes = 0;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/csrf") {
        csrfReads++;
        return new Response(JSON.stringify({csrf: csrfReads === 1 ? "first-session" : "rotated-session"}), {status: 200});
      }
      writes++;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-csrf-token"], writes === 1 ? "first-session" : "rotated-session");
      if (writes === 1) return new Response("{}", {status: 403});
      return new Response(JSON.stringify({status: "saved", message: "Saved", snapshot}), {status: 200});
    };

    const {loadAccess} = await import("../ui/src/access.js");
    assert.equal(await loadAccess(), true);
    await assert.rejects(saveProjectSupervisor(input, "stale-prop-token"), (error: unknown) =>
      error instanceof ProjectSupervisorRequestError && error.definitelyNotSaved && /Session refreshed/.test(error.message));
    assert.equal(writes, 1);
    assert.equal(csrfReads, 2);

    assert.equal((await saveProjectSupervisor(input, "stale-prop-token")).status, "saved");
    assert.equal(writes, 2);
    assert.equal(csrfReads, 2);
  } finally {globalThis.fetch = original;}
});

test("unconfirmed HTTP mutation outcomes are marked unsafe to retry without refresh", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", {status: 500});
    await assert.rejects(saveProjectSupervisor(input, "token"), (error: unknown) => error instanceof ProjectSupervisorRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = original;}
});
