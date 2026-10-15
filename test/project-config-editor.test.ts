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
import {makeDefinitionFixture, stepSource, workflowSource} from "./project-definitions-fixture.js";

const seedProject = (f: ReturnType<typeof makeDefinitionFixture>, config = "required: []\n") => {
  f.addFile(f.root, ".t3-supervisor/project.yaml", config);
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", stepSource("local-step"));
  f.addFile(f.root, ".t3-supervisor/steps/second-step.md", stepSource("second-step"));
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", workflowSource("Local flow", "  - step: local-step\n"));
};

test("saves only local project.yaml, preserves valid YAML comments and retains global policy", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", "required:\n  - step: shared-step\ndefault_workflow: shared-flow\n");
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared-step.md", stepSource("shared-step"));
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/shared-flow.yaml", workflowSource("Shared flow", "  - step: shared-step\n"));
  const oldConfig = `# project options\nrequired:\n  # keep the existing local requirement\n  - step: local-step # keep this reference comment\ndefault_workflow: local-flow # keep this default comment\n`;
  seedProject(f, oldConfig);
  const observed = await f.loader.load(f.projectId);
  assert.equal(observed.status, "ready");
  assert.equal(observed.projectConfig?.required[0] && "step" in observed.projectConfig.required[0] ? observed.projectConfig.required[0].step : null, "local-step");
  assert.equal(observed.config.required.length, 2);

  let savedSnapshotRevision: string | undefined;
  const editor = new ProjectConfigEditor(f.loader, f.writer, definitions => {savedSnapshotRevision = definitions.revision ?? undefined;});
  const input: ProjectConfigSave = {
    projectId: f.projectId,
    threadId: null,
    expectedRevision: observed.revision!,
    config: {required: [{step: "local-step"}, {step: "second-step"}, {workflow: "local-flow"}], default_workflow: "local-flow"},
  };
  const result = await editor.save(input);
  assert.equal(result.status, "saved");
  assert.equal(result.definitions?.complete, true);
  assert.deepEqual(result.definitions?.projectConfig, input.config);
  assert.equal(result.definitions?.config.required.length, 4);
  assert.equal(result.definitions?.config.default_workflow, "local-flow");
  assert.ok(savedSnapshotRevision);
  assert.deepEqual(f.writes.map(write => [write.root, write.path]), [[f.root, ".t3-supervisor/project.yaml"]]);
  const written = f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "";
  assert.match(written, /# project options/);
  assert.match(written, /# keep the existing local requirement/);
  assert.match(written, /# keep this reference comment/);
  assert.match(written, /# keep this default comment/);
  assert.equal(f.trees.get(f.globalRoot)?.get(".t3-supervisor/project.yaml"), "required:\n  - step: shared-step\ndefault_workflow: shared-flow\n");
});

test("rejects stale or global/unknown references before writing", async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  seedProject(f);
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", "required: []\n");
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared.md", stepSource("shared"));
  const initial = await f.loader.load(f.projectId);
  const editor = new ProjectConfigEditor(f.loader, f.writer);
  f.addFile(f.root, ".t3-supervisor/steps/new-step.md", stepSource("new-step"));
  const stale = await editor.save({projectId: f.projectId, threadId: null, expectedRevision: initial.revision!, config: {required: []}});
  assert.equal(stale.status, "conflict");
  assert.equal(f.writes.length, 0);

  const fresh = await f.loader.load(f.projectId);
  const globalStep = fresh.steps.find(step => step.origin === "global")!;
  const injected = await editor.save({projectId: f.projectId, threadId: null, expectedRevision: fresh.revision!, config: {required: [{step: globalStep.id}]}});
  assert.equal(injected.status, "invalid");
  const unknown = await editor.save({projectId: f.projectId, threadId: null, expectedRevision: fresh.revision!, config: {required: [{step: "missing"}]}});
  assert.equal(unknown.status, "invalid");
  assert.equal(f.writes.length, 0);
});

test("reports definite permission and uncertain native write outcomes without retrying", async () => {
  const f = makeDefinitionFixture();
  seedProject(f);
  const definitions = await f.loader.load(f.projectId);
  const input: ProjectConfigSave = {projectId: f.projectId, threadId: null, expectedRevision: definitions.revision!, config: {required: [{step: "local-step"}]}};
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
    await writer.writeProjectConfig("/workspace", "required: []\n", signal);
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
    dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", mcpxUrl: "unused", cxCommand: "unused", cxHome: directory,
    cxSeedFile: "unused", excludedThreadIds: [], healthPort: 0, modelTimeoutMs: 1000, uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: directory,
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
    const payload = {projectId: "project", threadId: null, expectedRevision: observed.revision, config: {required: [{step: "local-step"}]}};
    const rejected = await fetch(origin + "/api/guidance/project-configuration", {
      method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    assert.equal(rejected.status, 403);
    assert.equal(f.writes.length, 0);
    const csrf = await fetch(origin + "/api/csrf", {headers}).then(response => response.json()) as {csrf: string};
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
