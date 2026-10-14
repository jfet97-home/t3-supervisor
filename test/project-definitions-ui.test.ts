import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DefinitionsContent } from "../ui/src/project-definitions.js";
import { loadProjectDefinitions } from "../ui/src/project-definitions-api.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";

const definitions: ProjectDefinitionSnapshot = {
  projectId: "project", threadId: null, workspaceRoot: "/workspace", revision: "a".repeat(64), editingAvailable: true, status: "ready", issues: [],
  rules: [{name: "Review changes", description: "Changes require independent review.", required_blocks: ["review"]}],
  blocks: [{id: "review", name: "Review", description: "Inspect changes", instructions: "Check errors and existing patterns.", expected_result: "Findings and resolutions."}],
};

test("definition UI shows rules, block links, instructions and completion expectations", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  assert.match(html, /Review changes/);assert.match(html, /Required blocks/);assert.match(html, /definition-block-review/);
  assert.match(html, /Check errors and existing patterns/);assert.match(html, /Findings and resolutions/);
  assert.match(html, /Referenced by loaded rules: Review changes/);assert.match(html, /<details/);assert.match(html, /<summary/);
});

test("unreadable rules never imply that requirements or block references are absent", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions, status: "invalid", rules: [],
    issues: [{path: ".t3-supervisor/rules.yaml", code: "invalid_definition", message: "Invalid YAML."}]}}));
  assert.match(html, /No readable rules are available/);assert.match(html, /Invalid YAML/);
  assert.doesNotMatch(html, /No requirements are declared|No declared rule references|Referenced by/);
});

test("invalid collections stay visibly invalid and missing references never become inspect buttons", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions, status: "invalid", blocks: [],
    issues: [{path: ".t3-supervisor/rules.yaml", code: "block_reference_missing", message: "Missing review block."}]}}));
  assert.match(html, /Definitions need attention/);assert.match(html, /Missing or invalid: review/);assert.match(html, /Missing review block/);
  assert.doesNotMatch(html, /<button/);
});

test("repository markup stays escaped text rather than executable or interactive HTML", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions,
    blocks: [{...definitions.blocks[0]!, instructions: '<script>window.injected=true</script><img src=x onerror="alert(1)">'}]}}));
  assert.doesNotMatch(html, /<script>|<img/);assert.match(html, /&lt;script&gt;/);
});

test("definition client validates target identity and passes cancellation to same-origin GET", async () => {
  const original = globalThis.fetch;const controller = new AbortController();
  try {
    let seen = "";globalThis.fetch = async (input, init) => {
      seen = String(input);assert.equal(init?.signal, controller.signal);assert.equal(init?.credentials, "same-origin");
      return new Response(JSON.stringify({...definitions, projectId: "project & other", threadId: "thread?#"}), {status: 200});
    };
    const result = await loadProjectDefinitions("project & other", "thread?#", controller.signal);
    assert.equal(result.threadId, "thread?#");const query = new URL(seen, "http://localhost").searchParams;
    assert.equal(query.get("projectId"), "project & other");assert.equal(query.get("threadId"), "thread?#");
    globalThis.fetch = async () => new Response(JSON.stringify({...definitions, projectId: "wrong"}));
    await assert.rejects(loadProjectDefinitions("project", null, controller.signal));
    globalThis.fetch = async () => new Response(JSON.stringify({status: "ready"}));
    await assert.rejects(loadProjectDefinitions("project", null, controller.signal));
    globalThis.fetch = async () => new Response(JSON.stringify(definitions));controller.abort();
    await assert.rejects(loadProjectDefinitions("project", null, controller.signal));
  } finally {globalThis.fetch = original;}
});

test("a restarted session refreshes CSRF without retrying the write or locking the draft", async () => {
  const {saveProjectRules, ProjectRuleRequestError} = await import("../ui/src/project-definitions-api.js");
  const {loadAccess} = await import("../ui/src/access.js");
  const previous = globalThis.fetch;let currentToken = "first-session";let writes = 0;
  const input = {projectId: "project", threadId: null, expectedRevision: "a".repeat(64), rules: definitions.rules};
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/csrf") return new Response(JSON.stringify({csrf: currentToken}));
      writes++;
      if ((init?.headers as Record<string, string>)["x-csrf-token"] !== currentToken) return new Response("{}", {status: 403});
      return new Response(JSON.stringify({status: "saved", message: "Saved", definitions}));
    };
    assert.equal(await loadAccess(), true);currentToken = "after-restart";
    await assert.rejects(saveProjectRules(input, "first-session"), (error: unknown) => error instanceof ProjectRuleRequestError && error.definitelyNotSaved && /Session refreshed/.test(error.message));
    assert.equal(writes, 1);
    assert.equal((await saveProjectRules(input, "first-session")).status, "saved");assert.equal(writes, 2);
    for (const status of [413, 415]) {
      globalThis.fetch = async () => new Response("{}", {status});
      await assert.rejects(saveProjectRules(input, "old"), (error: unknown) => error instanceof ProjectRuleRequestError && error.definitelyNotSaved);
    }
    globalThis.fetch = async () => new Response("{}", {status: 500});
    await assert.rejects(saveProjectRules(input, "old"), (error: unknown) => error instanceof ProjectRuleRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = previous;}
});

test("real HTTP restart renews access and preserves an explicit second-save opportunity", async () => {
  const {startGuidanceUi} = await import("../src/guidance-ui.js");
  const {mkdtemp, rm} = await import("node:fs/promises");const {join} = await import("node:path");const {tmpdir} = await import("node:os");
  const {loadAccess, getCsrfToken} = await import("../ui/src/access.js");
  const {saveProjectRules, ProjectRuleRequestError} = await import("../ui/src/project-definitions-api.js");
  const directory = await mkdtemp(join(tmpdir(), "rule-session-restart-"));
  const config = {dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", mcpxUrl: "unused", cxCommand: "unused", cxHome: directory, cxSeedFile: "unused", excludedThreadIds: [], healthPort: 0, modelTimeoutMs: 1000, uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: directory};
  let saves = 0;
  const editor = {save: async () => {saves++;return {status: "saved" as const, message: "Saved", definitions};}} as unknown as import("../src/project-rule-editor.js").ProjectRuleEditor;
  const runtime = {retired: true} as import("../src/guidance.js").GuidanceRuntime;
  let ui = await startGuidanceUi(config, runtime, undefined, editor);
  const address = ui.server.address();assert.ok(address && typeof address !== "string");const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (input, init) => originalFetch(new URL(String(input), origin), {...init, headers: {...init?.headers, ...(init?.method === "POST" ? {Origin: origin} : {})}});
    assert.equal(await loadAccess(), true);const stale = getCsrfToken();await ui.close();
    ui = await startGuidanceUi({...config, uiPort: address.port}, runtime, undefined, editor);
    const input = {projectId: "project", threadId: null, expectedRevision: "a".repeat(64), rules: definitions.rules};
    await assert.rejects(saveProjectRules(input, stale), (error: unknown) => error instanceof ProjectRuleRequestError && error.definitelyNotSaved);
    assert.equal(saves, 0);assert.notEqual(getCsrfToken(), stale);
    assert.equal((await saveProjectRules(input, stale)).status, "saved");assert.equal(saves, 1);
  } finally {globalThis.fetch = originalFetch;await ui.close();await rm(directory, {recursive: true, force: true});}
});
