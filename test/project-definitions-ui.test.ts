import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DefinitionsContent } from "../ui/src/project-definitions.js";
import { loadProjectDefinitions } from "../ui/src/project-definitions-api.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";

const definitions: ProjectDefinitionSnapshot = {
  projectId: "project", threadId: null, workspaceRoot: "/workspace", status: "ready", issues: [],
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
    issues: [{path: ".supervisor/rules.yaml", code: "invalid_definition", message: "Invalid YAML."}]}}));
  assert.match(html, /No readable rules are available/);assert.match(html, /Invalid YAML/);
  assert.doesNotMatch(html, /No requirements are declared|No declared rule references|Referenced by/);
});

test("invalid collections stay visibly invalid and missing references never become inspect buttons", () => {
  const html = renderToStaticMarkup(createElement(DefinitionsContent, {definitions: {...definitions, status: "invalid", blocks: [],
    issues: [{path: ".supervisor/rules.yaml", code: "block_reference_missing", message: "Missing review block."}]}}));
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
