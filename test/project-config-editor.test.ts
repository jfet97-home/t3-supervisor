import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {WebSocketServer} from "ws";
import {ProjectConfigEditor} from "../src/project-config-editor.js";
import type {ProjectConfigSave} from "../src/project-definitions-contract.js";
import {ProjectFileError, makeProjectWriter} from "../src/project-files.js";
import {forgeDashboardToken} from "../src/service-auth.js";
import {startGuidanceUi} from "../src/guidance-ui.js";
import type {GuidanceRuntime} from "../src/guidance.js";
import type {SupervisorConfig} from "../src/types.js";
import {requiredReferences, type DefinitionReference} from "../src/project-definitions-contract.js";
import {indexEntry, indexSource, makeDefinitionFixture, projectIndex, stepSource, workflowSource} from "./project-definitions-fixture.js";

const localIndex = (required: readonly DefinitionReference[] = []) =>
  projectIndex({steps: ["local-step", "second-step"], workflows: ["local-flow"], required});
const seedProject = (f: ReturnType<typeof makeDefinitionFixture>, config = indexSource({steps: ["local-step", "second-step"], workflows: ["local-flow"]})) => {
  f.addFile(f.root, ".t3-supervisor/project.yaml", config);
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", stepSource("local-step"));
  f.addFile(f.root, ".t3-supervisor/steps/second-step.md", stepSource("second-step"));
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", workflowSource("Local flow", "  - step: local-step\n"));
};

test("saves only local project.yaml, preserves valid YAML comments and retains global policy", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  const globalIndex = indexSource({steps: ["shared-step"], workflows: ["shared-flow"], required: [{step: "shared-step"}], default_workflow: "shared-flow"});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", globalIndex);
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared-step.md", stepSource("shared-step"));
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/shared-flow.yaml", workflowSource("Shared flow", "  - step: shared-step\n"));
  const oldConfig = `# project options
workflows:
  # the local flow
  - id: local-flow # keep this row comment
    path: workflows/local-flow.yaml
    summary: Run the local flow for checkout changes.
    required: false
steps:
  - id: local-step
    path: steps/local-step.md
    summary: Check the local behavior. # keep this summary comment
    required: true
  - id: second-step
    path: steps/second-step.md
    summary: Run the second check.
    required: false
default_workflow: local-flow # keep this default comment
`;
  seedProject(f, oldConfig);
  const observed = await f.loader.load(f.projectId);
  assert.equal(observed.status, "ready");
  assert.deepEqual(requiredReferences(observed.projectConfig!), [{step: "local-step"}]);
  assert.equal(requiredReferences(observed.config).length, 2, "the global requirement stays in the effective index");

  let savedSnapshotRevision: string | undefined;
  const editor = new ProjectConfigEditor(f.loader, f.writer, definitions => {savedSnapshotRevision = definitions.revision ?? undefined;});
  const input: ProjectConfigSave = {
    projectId: f.projectId,
    threadId: null,
    expectedRevision: observed.revision!,
    config: {
      workflows: [{...observed.projectConfig!.workflows[0]!, summary: "Run the local flow for checkout changes.\r\n  Use it for every local edit.  "}],
      steps: [observed.projectConfig!.steps[0]!, {...observed.projectConfig!.steps[1]!, required: true}],
      default_workflow: "local-flow",
    },
  };
  const result = await editor.save(input);
  assert.equal(result.status, "saved", result.message);
  assert.equal(result.definitions?.complete, true);
  assert.equal(result.definitions?.projectConfig?.workflows[0]?.summary, "Run the local flow for checkout changes.\nUse it for every local edit.", "a two-line summary is saved normalized");
  assert.deepEqual(requiredReferences(result.definitions!.projectConfig!), [{step: "local-step"}, {step: "second-step"}]);
  assert.equal(requiredReferences(result.definitions!.config).length, 3);
  assert.equal(result.definitions?.config.default_workflow, "local-flow");
  assert.ok(savedSnapshotRevision);
  assert.deepEqual(f.writes.map(write => [write.root, write.path]), [[f.root, ".t3-supervisor/project.yaml"]]);
  const written = f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "";
  for (const comment of ["# project options", "# the local flow", "# keep this row comment", "# keep this summary comment", "# keep this default comment"])
    assert.ok(written.includes(comment), comment);
  assert.doesNotMatch(written, /^required:/mu, "no second required source is written");
  assert.equal(f.trees.get(f.globalRoot)?.get(".t3-supervisor/project.yaml"), globalIndex);
});

test("indexes an existing unlisted file and rejects stale, missing-file, global, malformed or old-format indexes before writing", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  seedProject(f);
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", indexSource({steps: ["shared"]}));
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared.md", stepSource("shared"));
  f.addDirectory(f.globalRoot, ".t3-supervisor/workflows");
  const initial = await f.loader.load(f.projectId);
  const editor = new ProjectConfigEditor(f.loader, f.writer);
  f.addFile(f.root, ".t3-supervisor/steps/new-step.md", stepSource("new-step"));
  const stale = await editor.save({projectId: f.projectId, threadId: null, expectedRevision: initial.revision!, config: localIndex()});
  assert.equal(stale.status, "conflict");
  assert.equal(f.writes.length, 0);

  const fresh = await f.loader.load(f.projectId);
  assert.ok(fresh.issues.some(issue => issue.code === "definition_unlisted" && issue.path.endsWith("new-step.md")));
  const globalStep = fresh.config.steps.find(row => row.origin === "global")!;
  const save = (config: unknown) => editor.save({projectId: f.projectId, threadId: null, expectedRevision: fresh.revision!, config: config as ProjectConfigSave["config"]});
  const injected = await save({...localIndex(), steps: [...localIndex().steps, indexEntry("steps", globalStep.id)]});
  assert.equal(injected.status, "invalid");
  assert.match(injected.message, /needs an existing \.t3-supervisor\/steps\//u, "a global row cannot be written into the local index");
  const missing = await save({...localIndex(), steps: [...localIndex().steps, indexEntry("steps", "missing")]});
  assert.equal(missing.status, "invalid");
  assert.match(missing.message, /missing needs an existing \.t3-supervisor\/steps\/missing\.md/u);
  const threeLines = await save({...localIndex(), steps: [{...localIndex().steps[0]!, summary: "One.\nTwo.\nThree."}, localIndex().steps[1]!]});
  assert.equal(threeLines.status, "invalid");
  assert.match(threeLines.message, /at most 2 nonempty lines/u);
  const wrongPath = await save({...localIndex(), steps: [{...localIndex().steps[0]!, path: "steps/elsewhere.md"}, localIndex().steps[1]!]});
  assert.match(wrongPath.message, /path must be steps\/local-step\.md/u);
  assert.equal((await save({required: [{step: "local-step"}]})).status, "invalid", "the old required list is not an accepted payload");
  const mixed = await save({...localIndex(), required: [{step: "local-step"}]});
  assert.equal(mixed.status, "invalid", "a legacy required list beside the index is rejected, not dropped");
  assert.match(mixed.message, /each entry's required flag/u);
  assert.equal((await save({...localIndex(), steps: [{...localIndex().steps[0]!, extra: true}, localIndex().steps[1]!]})).status, "invalid");
  assert.equal(f.writes.length, 0);

  const indexed = await save({...localIndex([{step: "new-step"}]), steps: [...localIndex().steps, indexEntry("steps", "new-step", true, "Check new behavior before release.")]});
  assert.equal(indexed.status, "saved", indexed.message);
  assert.equal(indexed.definitions?.status, "ready");
  assert.ok(indexed.definitions?.steps.some(step => step.id === "new-step" && step.summary === "Check new behavior before release."));
  assert.deepEqual(requiredReferences(indexed.definitions!.projectConfig!), [{step: "new-step"}]);
});

test("reports definite permission and uncertain native write outcomes without retrying", async () => {
  const f = makeDefinitionFixture();
  seedProject(f);
  const definitions = await f.loader.load(f.projectId);
  const input: ProjectConfigSave = {projectId: f.projectId, threadId: null, expectedRevision: definitions.revision!, config: localIndex([{step: "local-step"}])};
  const editor = new ProjectConfigEditor(f.loader, f.writer);
  f.writer.writeProjectConfig = async () => {throw new ProjectFileError("permission_required", "write");};
  assert.equal((await editor.save(input)).status, "permission_required");
  let attempts = 0;
  f.writer.writeProjectConfig = async () => {attempts++;throw new Error("connection closed");};
  assert.equal((await editor.save(input)).status, "uncertain");
  assert.equal(attempts, 1);
  f.writer.writeProjectConfig = async () => {attempts++;};
  assert.equal((await editor.save(input)).status, "uncertain");
  assert.equal(attempts, 2);
});

test("native project writer checks the regular project.yaml target and writes only its fixed path", async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();assert.ok(address && typeof address !== "string");
  const calls: Array<{tag: string; payload: Record<string, unknown>}> = [];
  let targetKind: "file" | "directory" | "missing" = "file";
  server.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(data.toString()) as {id: string; tag: string; payload: Record<string, unknown>};
    calls.push({tag: request.tag, payload: request.payload});
    let value: unknown;
    if (request.tag === "projects.listEntries") {
      const path = request.payload.directoryPath;
      value = path === ""
        ? {truncated: false, entries: [{path: ".t3-supervisor", kind: "directory"}]}
        : {truncated: false, entries: targetKind === "missing" ? [] : [{path: ".t3-supervisor/project.yaml", kind: targetKind}]};
    } else if (request.tag === "projects.writeFile") value = {relativePath: request.payload.relativePath};
    else value = null;
    socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: {_tag: "Success", value}}));
  }));
  try {
    const writer = makeProjectWriter(`http://127.0.0.1:${address.port}`, "fixture");
    const signal = AbortSignal.timeout(5000);
    assert.equal(await writer.checkProjectConfigFile("/workspace", signal), true);
    await writer.writeProjectConfig("/workspace", "workflows: []\nsteps: []\n", signal);
    assert.equal(calls.filter(call => call.tag === "projects.writeFile").length, 1);
    assert.equal(calls.find(call => call.tag === "projects.writeFile")?.payload.relativePath, ".t3-supervisor/project.yaml");
    targetKind = "directory";
    assert.equal(await writer.checkProjectConfigFile("/workspace", signal), false);
    targetKind = "missing";
    assert.equal(await writer.checkProjectConfigFile("/workspace", signal), false);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("project-configuration endpoint keeps session, origin and CSRF checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-config-api-"));
  const f = makeDefinitionFixture();
  seedProject(f);
  const editor = new ProjectConfigEditor(f.loader, f.writer);
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0,
    uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: directory,
  };
  const ui = await startGuidanceUi(config, {} as GuidanceRuntime, f.loader, editor);
  try {
    const address = ui.server.address();assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const grant = await forgeDashboardToken(directory);
    const login = await fetch(origin + "/auth/login", {
      method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify({token: grant.token}),
    });
    assert.equal(login.status, 200);
    const session = (await login.json() as {session: string}).session;
    const headers = {"x-supervisor-session": session};
    const path = "/api/guidance/project-configuration?projectId=project";
    assert.equal((await fetch(origin + path)).status, 401);
    assert.equal((await fetch(origin + path, {headers: {...headers, Origin: "https://foreign.invalid"}})).status, 403);
    const observedResponse = await fetch(origin + path, {headers});
    assert.equal(observedResponse.status, 200);
    const observed = await observedResponse.json() as {status: string; revision: string; projectConfig: unknown};
    assert.equal(observed.status, "ready");
    assert.ok(observed.revision);
    const payload = {projectId: "project", threadId: null, expectedRevision: observed.revision, config: localIndex([{step: "local-step"}])};
    const rejected = await fetch(origin + "/api/guidance/project-configuration", {
      method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    assert.equal(rejected.status, 403);
    assert.equal(f.writes.length, 0);
    const csrf = await fetch(origin + "/api/csrf", {headers}).then(response => response.json()) as {csrf: string};
    // legacy or unknown fields are rejected while decoding the request, before any normalization or write
    for (const config of [{...localIndex(), required: [{step: "local-step"}]}, {...localIndex(), steps: [{...localIndex().steps[0]!, extra: true}, localIndex().steps[1]!]}]) {
      const strict = await fetch(origin + "/api/guidance/project-configuration", {
        method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.csrf},
        body: JSON.stringify({...payload, config}),
      });
      assert.notEqual(strict.status, 200, JSON.stringify(config));
      assert.equal(f.writes.length, 0, "nothing is written for a request with an unknown field");
    }
    const saved = await fetch(origin + "/api/guidance/project-configuration", {
      method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.csrf}, body: JSON.stringify(payload),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as {status: string}).status, "saved");
    assert.deepEqual(f.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  } finally {
    await ui.close();
    await rm(directory, {recursive: true, force: true});
  }
});
