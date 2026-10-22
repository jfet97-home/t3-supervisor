import assert from "node:assert/strict";
import { it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DefinitionsContent } from "../ui/src/project-definitions.js";
import { ProjectCatalogFields, ProjectConfigurationEditor } from "../ui/src/project-configuration-editor.js";
import { loadProjectDefinitions } from "../ui/src/project-definitions-api.js";
import { ProjectConfigRequestError, saveProjectConfiguration } from "../ui/src/project-definitions-api.js";
import { normalizeProjectConfiguration, projectConfigurationError, type ProjectConfigSave, type ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { clearAccess, loadAccess } from "../ui/src/access.js";

const definitions: ProjectDefinitionSnapshot = {
  projectId: "project",
  threadId: null,
  workspaceRoot: "/workspace",
  globalOnly: false,
  globalRevision: null,
  revision: "a".repeat(64),
  editingAvailable: true,
  status: "ready",
  steps: [
    {id: "e2e-testing", name: "End-to-end testing", summary: "Verify changed behavior in the real application.", description: "Test the changed behavior.", origin: "project", path: ".t3-supervisor/steps/e2e-testing.md", sourceId: "e2e-testing"},
    {id: "security-review", name: "Security review", summary: "Inspect affected trust boundaries.", description: "Check the relevant trust boundaries.", origin: "global", path: "~/.t3-supervisor/steps/security-review.md", sourceId: "security-review"},
  ],
  workflows: [{
    id: "reviewer", name: "Reviewer", summary: "Review changes before delivery.", description: "Review the change and verify affected behavior.", fixed: true,
    sequence: [
      {step: "e2e-testing"},
      {parallel: [{step: "security-review"}, {step: {id: "inspect-notes", name: "Inspect notes", description: "Check the task-specific notes."}}]},
      {workflow: "missing-review"},
    ],
    origin: "project", path: ".t3-supervisor/workflows/reviewer.yaml", sourceId: "reviewer",
  }],
  config: {
    workflows: [{id: "reviewer", path: "workflows/reviewer.yaml", summary: "Review changes before delivery.", required: false, origin: "project", sourceId: "reviewer"}],
    steps: [
      {id: "security-review", path: "steps/security-review.md", summary: "Inspect affected trust boundaries.", required: true, origin: "global", sourceId: "security-review"},
      {id: "e2e-testing", path: "steps/e2e-testing.md", summary: "Verify changed behavior in the real application.", required: true, origin: "project", sourceId: "e2e-testing"},
    ],
    default_workflow: "reviewer",
  },
  projectConfig: {
    workflows: [{path: "workflows/reviewer.yaml", summary: "Review changes before delivery.", required: false}],
    steps: [{path: "steps/e2e-testing.md", summary: "Verify changed behavior in the real application.", required: true}],
    default_workflow: "reviewer",
  },
  definitionFiles: [
    {origin: "project", kind: "steps", id: "e2e-testing", path: "steps/e2e-testing.md"},
    {origin: "project", kind: "workflows", id: "reviewer", path: "workflows/reviewer.yaml"},
  ],
  complete: true,
  sources: [{path: ".t3-supervisor/project.yaml", origin: "project", content: "workflows: []\nsteps: []\n"}],
  issues: [],
};

it("definitions UI shows effective global and project requirements plus nested workflow structure", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  assert.match(html, /Effective requirements/);
  assert.match(html, /End-to-end testing/);
  assert.match(html, /Security review/);
  assert.match(html, /Workflow reference cycle|Missing or invalid workflow: missing-review/);
  assert.match(html, /Fixed fragment/);
  assert.match(html, /Parallel group/);
  assert.match(html, /Local step:<\/strong> Inspect notes/);
  assert.match(html, /intended semantic order/);
  assert.match(html, /project\.yaml/);
  assert.match(html, /<details/);
  assert.match(html, /<summary/);
  assert.match(html, /Workflows index/);
  assert.match(html, /Steps index/);
  assert.match(html, /Review changes before delivery/);
  assert.match(html, /Global · read-only/);
  assert.match(html, /Optional/);
  assert.match(html, /task plans can add local steps and new combinations/);
  assert.doesNotMatch(html, /Project rules|Reusable blocks|instructions|expected result/i);
});

it("invalid and incomplete collections never imply that unreadable requirements are absent", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions, status: "invalid", complete: false, config: {workflows: [], steps: []}, steps: [],
    issues: [{path: ".t3-supervisor/workflows/reviewer.yaml", code: "workflow_cycle", message: "Workflow reference cycle: reviewer -> nested -> reviewer."}]}}));
  assert.match(html, /Definitions need attention/);
  assert.match(html, /Read incomplete/);
  assert.match(html, /may be only part of the requirements/);
  assert.match(html, /Workflow reference cycle: reviewer -&gt; nested -&gt; reviewer/);
  assert.match(html, /No readable required references are available/);
  assert.doesNotMatch(html, /No effective required references are configured/);
});

it("raw repository source is escaped plain text and missing references stay diagnostic text", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions,
    workflows: [{...definitions.workflows[0]!, sequence: [{step: "missing-step"}]}],
    sources: [{path: ".t3-supervisor/steps/bad.md", origin: "project", content: '<script>window.injected=true</script><img src=x onerror="alert(1)">'}],
  }}));
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /Missing or invalid step: missing-step/);
});

it("configuration editor saves checkout-local defaults and remains available to repair a fully read invalid collection", () => {
  const invalid = {...definitions, status: "invalid" as const, issues: [{path: ".t3-supervisor/workflows/reviewer.yaml", code: "workflow_cycle", message: "Workflow reference cycle."}]};
  const html = renderToStaticMarkup(createElement(ProjectConfigurationEditor, {
    definitions: invalid,
    csrfToken: "csrf",
    onSaved: () => {},
    onDirtyChange: () => {},
    onSavingChange: () => {},
  }));
  assert.match(html, /Edit project configuration/);
  assert.match(html, /Required in this checkout:<\/strong> step:e2e-testing/);
  assert.doesNotMatch(html, /Required in this checkout:[\s\S]*security-review/);
  assert.match(html, /selected checkout&#x27;s <code>\.t3-supervisor\/project\.yaml<\/code>/);
});

it("a complete readable but invalid project.yaml can be replaced without claiming its requirements were empty", () => {
  const invalid = {...definitions, status: "invalid" as const, projectConfig: null, complete: true, revision: "b".repeat(64),
    sources: [{path: ".t3-supervisor/project.yaml", origin: "project" as const, content: "workflows: [broken"}],
    issues: [{path: ".t3-supervisor/project.yaml", code: "project_configuration_invalid", message: "Invalid YAML."}]};
  const html = renderToStaticMarkup(createElement(ProjectConfigurationEditor, {
    definitions: invalid,
    csrfToken: "csrf",
    onSaved: () => {},
    onDirtyChange: () => {},
    onSavingChange: () => {},
  }));
  assert.match(html, /Project configuration needs repair/);
  assert.match(html, /Repair project configuration/);
  assert.match(html, /requirements are unknown/);
  assert.match(html, /empty replacement draft/);
  assert.match(html, /workflows: \[broken/);
  assert.doesNotMatch(html, /Required in this checkout:<\/strong> None/);
});

it("global-only and incomplete snapshots never expose project configuration editing", () => {
  const props = {csrfToken: "csrf", onSaved: () => {}, onDirtyChange: () => {}, onSavingChange: () => {}};
  const globalHtml = renderToStaticMarkup(createElement(ProjectConfigurationEditor, {definitions: {...definitions, globalOnly: true}, ...props}));
  assert.match(globalHtml, /global-only/);
  assert.doesNotMatch(globalHtml, /Edit project configuration/);
  const incompleteHtml = renderToStaticMarkup(createElement(ProjectConfigurationEditor, {definitions: {...definitions, complete: false}, ...props}));
  assert.match(incompleteHtml, /complete read and a current revision/);
  assert.doesNotMatch(incompleteHtml, /Edit project configuration/);
});

it("catalog UI retains required missing rows and separates authored summaries from full policy", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions, status: "invalid", steps: [], workflows: []}}));
  assert.match(html, /Verify changed behavior in the real application/);
  assert.match(html, /Missing or invalid step: e2e-testing/);
  assert.match(html, /index entry and required flag are retained/);
  assert.match(html, /Required step/);
  assert.match(html, /workflows\/reviewer.yaml/);
  assert.doesNotMatch(html, /No effective required references/);
});

it("catalog editor fields keep missing and invalid draft rows, label native controls and offer unlisted local files", () => {
  const config = {...definitions.projectConfig!, steps: [
    ...definitions.projectConfig!.steps,
    {path: "../outside.md", summary: "First line\nSecond line\nThird line", required: true},
  ]};
  const scope = {...definitions, definitionFiles: [...definitions.definitionFiles!,
    {origin: "project" as const, kind: "steps" as const, id: "unlisted", path: "steps/unlisted.md"},
    {origin: "global" as const, kind: "steps" as const, id: "global-only", path: "steps/global-only.md"},
  ]};
  const props = {kind: "steps" as const, config, definitions: scope, disabled: false, onChange: () => {}};
  const html = renderToStaticMarkup(createElement(ProjectCatalogFields, props));
  assert.match(html, /<legend>Steps/);
  assert.match(html, /value="\.\.\/outside.md"/);
  assert.match(html, /First line\nSecond line\nThird line/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.match(html, /rows="2" maxLength="240"/);
  assert.match(html, /purpose or applicability from the full description/);
  assert.match(html, /Index steps\/unlisted\.md/);
  assert.match(html, /the file name is the definition ID \(<code>e2e-testing<\/code>\)/);
  assert.doesNotMatch(html, /global-only|Index steps\/e2e-testing|disabled=""|-id"/);
  const labels = [...html.matchAll(/<label[^>]* for="([^"]+)"/g)].map(match => match[1]);
  const controls = [...html.matchAll(/<(?:input|textarea)[^>]* id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(controls.length, 6, "each row edits path, summary and required; the ID comes from the path");
  assert.equal(new Set(controls).size, controls.length);
  for (const id of controls) assert(labels.includes(id), `missing visible label for ${id}`);
  const locked = renderToStaticMarkup(createElement(ProjectCatalogFields, {...props, disabled: true}));
  assert.match(locked, /^<fieldset disabled=""/);
  assert.match(locked, /value="\.\.\/outside.md"/);
  assert.match(locked, /Third line/);
});

it("editor shared validation enforces summary and canonical path boundaries without extra name heuristics", () => {
  const base = definitions.projectConfig!;
  const withStep = (change: Partial<typeof base.steps[number]>) => ({...base, steps: [{...base.steps[0]!, ...change}]});
  const valid = normalizeProjectConfiguration(withStep({summary: ` ${"a".repeat(119)}\r\n${"b".repeat(120)} `}));
  assert.equal(valid.steps[0]!.summary.length, 240);
  assert.equal(projectConfigurationError(valid), null);
  assert.match(projectConfigurationError(withStep({summary: "first\nsecond\nthird"}))!, /2/);
  assert.match(projectConfigurationError(withStep({summary: "a".repeat(241)}))!, /240/);
  assert.match(projectConfigurationError(withStep({summary: "  "}))!, /nonempty/);
  assert.match(projectConfigurationError(withStep({path: "../steps/e2e-testing.md"}))!, /path must be steps\/<id>\.md/);
  assert.match(projectConfigurationError({...base, steps: [...base.steps, ...base.steps]})!, /more than once/);
  assert.equal(projectConfigurationError(withStep({summary: "e2e-testing"})), null);
  assert.equal(projectConfigurationError(withStep({summary: "End-to-end testing"})), null);
  assert.equal("required" in valid, false);
});

it("definition client reads the selected configuration scope and rejects mismatched snapshots", async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  try {
    let seen = "";
    globalThis.fetch = async (input, init) => {
      seen = String(input);
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.credentials, "omit");
      return new Response(JSON.stringify({...definitions, projectId: "project & other", threadId: "thread?#"}), {status: 200});
    };
    const result = await loadProjectDefinitions("project & other", "thread?#", controller.signal);
    assert.equal(result.threadId, "thread?#");
    const query = new URL(seen, "http://localhost").searchParams;
    assert.equal(new URL(seen, "http://localhost").pathname, "/api/guidance/project-configuration");
    assert.equal(query.get("projectId"), "project & other");
    assert.equal(query.get("threadId"), "thread?#");
    globalThis.fetch = async () => new Response(JSON.stringify({...definitions, projectId: "wrong"}));
    await assert.rejects(loadProjectDefinitions("project", null, controller.signal));
    globalThis.fetch = async () => new Response(JSON.stringify({status: "ready"}));
    await assert.rejects(loadProjectDefinitions("project", null, controller.signal));
    globalThis.fetch = async () => new Response(JSON.stringify(definitions));
    controller.abort();
    await assert.rejects(loadProjectDefinitions("project", null, controller.signal));
  } finally {globalThis.fetch = previous;}
});

it("configuration client posts local project.yaml config and preserves the origin session header", async () => {
  const previous = globalThis.fetch;
  const input: ProjectConfigSave = {projectId: "project", threadId: null, expectedRevision: definitions.revision!, config: definitions.projectConfig!};
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/guidance/project-configuration");
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "omit");
      assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), input);
      return new Response(JSON.stringify({status: "saved", message: "Saved project.yaml.", definitions}), {status: 200});
    };
    const result = await saveProjectConfiguration(input, "csrf-token");
    assert.equal(result.status, "saved");
    assert.equal(result.definitions?.projectId, "project");
  } finally {globalThis.fetch = previous;}
});

it("expired CSRF refresh keeps a definite no-save draft opportunity and never replays the POST", async () => {
  const previous = globalThis.fetch;
  const input: ProjectConfigSave = {projectId: "project", threadId: null, expectedRevision: definitions.revision!, config: definitions.projectConfig!};
  clearAccess();
  let currentToken = "first-session";
  let writes = 0;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/csrf") return new Response(JSON.stringify({csrf: currentToken}));
      writes++;
      if ((init?.headers as Record<string, string>)["x-csrf-token"] !== currentToken) return new Response("{}", {status: 403});
      return new Response(JSON.stringify({status: "saved", message: "Saved", definitions}), {status: 200});
    };
    assert.equal(await loadAccess(), true);
    currentToken = "after-restart";
    await assert.rejects(saveProjectConfiguration(input, "first-session"), (error: unknown) => error instanceof ProjectConfigRequestError && error.definitelyNotSaved && /Session refreshed/.test(error.message));
    assert.equal(writes, 1);
    assert.equal((await saveProjectConfiguration(input, "first-session")).status, "saved");
    assert.equal(writes, 2);
    for (const status of [413, 415]) {
      globalThis.fetch = async () => new Response("{}", {status});
      await assert.rejects(saveProjectConfiguration(input, "old"), (error: unknown) => error instanceof ProjectConfigRequestError && error.definitelyNotSaved);
    }
    globalThis.fetch = async () => new Response("{}", {status: 500});
    await assert.rejects(saveProjectConfiguration(input, "old"), (error: unknown) => error instanceof ProjectConfigRequestError && !error.definitelyNotSaved);
  } finally {globalThis.fetch = previous;clearAccess();}
});
