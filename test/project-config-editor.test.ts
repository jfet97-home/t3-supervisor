import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { it } from "@effect/vitest";
import {Context, Effect, Layer, Ref} from "effect";
import {WebSocketServer} from "ws";
import {ProjectConfigEditorService} from "../src/project-config-editor.js";
import {ProjectDefinitions} from "../src/project-definitions.js";
import {released} from "./support/http.js";
import type {ProjectConfigSave} from "../src/project-definitions-contract.js";
import {ProjectFileError, makeProjectWriter, type ProjectWriter} from "../src/project-files.js";
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
// the definitions and the config editor over the fixture's in-memory checkout, built for the test's scope
const services = (layer: Layer.Layer<ProjectDefinitions | ProjectConfigEditorService>) => Effect.map(Layer.build(layer),
  context => ({definitions: Context.get(context, ProjectDefinitions), editor: Context.get(context, ProjectConfigEditorService)}));
// a real loopback socket; the finalizer terminates its clients and closes it
const loopbackServer = Effect.acquireRelease(Effect.promise(async () => {
  const listening = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => listening.once("listening", resolve));
  return listening;
}), listening => Effect.promise(() => {
  for (const client of listening.clients) client.terminate();
  return new Promise<void>(resolve => listening.close(() => resolve()));
}));

it.live("saves only local project.yaml, preserves valid YAML comments and retains global policy", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({globalEnabled: true});
  const globalIndex = indexSource({steps: ["shared-step"], workflows: ["shared-flow"], required: [{step: "shared-step"}], default_workflow: "shared-flow"});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", globalIndex);
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared-step.md", stepSource("shared-step"));
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/shared-flow.yaml", workflowSource("Shared flow", "  - step: shared-step\n"));
  const oldConfig = `# project options
workflows:
  # the local flow
  - path: workflows/local-flow.yaml # keep this row comment
    summary: Run the local flow for checkout changes.
    required: false
steps:
  - path: steps/local-step.md
    summary: Check the local behavior. # keep this summary comment
    required: true
  - path: steps/second-step.md
    summary: Run the second check.
    required: false
default_workflow: local-flow # keep this default comment
`;
  seedProject(f, oldConfig);
  let savedSnapshotRevision: string | undefined;
  const {definitions, editor} = yield* services(f.editorLayer(f.writer, definitions => {savedSnapshotRevision = definitions.revision ?? undefined;}));
  const observed = yield* definitions.load(f.projectId);
  assert.equal(observed.status, "ready");
  assert.deepEqual(requiredReferences(observed.projectConfig!), [{step: "local-step"}]);
  assert.deepEqual(observed.config.steps.filter(row => row.origin === "project").map(row => [row.id, row.path]),
    [["local-step", "steps/local-step.md"], ["second-step", "steps/second-step.md"]], "the runtime ID is the indexed file name");
  assert.equal(requiredReferences(observed.config).length, 2, "the global requirement stays in the effective index");

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
  const result = yield* editor.save(input);
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
  assert.doesNotMatch(written, /\bid:/u, "index rows stay path-only");
  assert.equal(f.trees.get(f.globalRoot)?.get(".t3-supervisor/project.yaml"), globalIndex);

  // unchecking a requirement removes its flag from the compact file; reloading reads it back as false
  const unchecked = yield* editor.save({...input, expectedRevision: result.definitions!.revision!, config: {...input.config,
    steps: [input.config.steps[0]!, {...input.config.steps[1]!, required: false}]}});
  assert.equal(unchecked.status, "saved", unchecked.message);
  const compact = f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "";
  assert.doesNotMatch(compact, /required: false/u, "false flags are omitted");
  assert.equal(compact.match(/required: true/gu)?.length, 1, "only the remaining requirement keeps its flag");
  for (const comment of ["# project options", "# keep this summary comment", "# keep this default comment"]) assert.ok(compact.includes(comment), comment);
  const reloaded = yield* definitions.load(f.projectId);
  assert.deepEqual(reloaded.projectConfig?.steps.map(row => [row.path, row.required]), [["steps/local-step.md", true], ["steps/second-step.md", false]]);
  assert.deepEqual(reloaded.projectConfig?.workflows.map(row => row.required), [false]);
}));

it.live("indexes an existing unlisted file and rejects stale, missing-file, global, malformed or old-format indexes before writing", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({globalEnabled: true});
  seedProject(f);
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", indexSource({steps: ["shared"]}));
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared.md", stepSource("shared"));
  f.addDirectory(f.globalRoot, ".t3-supervisor/workflows");
  const {definitions, editor} = yield* services(f.editorLayer());
  const initial = yield* definitions.load(f.projectId);
  f.addFile(f.root, ".t3-supervisor/steps/new-step.md", stepSource("new-step"));
  const stale = yield* editor.save({projectId: f.projectId, threadId: null, expectedRevision: initial.revision!, config: localIndex()});
  assert.equal(stale.status, "conflict");
  assert.equal(f.writes.length, 0);

  const fresh = yield* definitions.load(f.projectId);
  assert.ok(fresh.issues.some(issue => issue.code === "definition_unlisted" && issue.path.endsWith("new-step.md")));
  const globalStep = fresh.config.steps.find(row => row.origin === "global")!;
  const save = (config: unknown) => editor.save({projectId: f.projectId, threadId: null, expectedRevision: fresh.revision!, config: config as ProjectConfigSave["config"]});
  const injected = yield* save({...localIndex(), steps: [...localIndex().steps, indexEntry("steps", globalStep.id)]});
  assert.equal(injected.status, "invalid");
  assert.match(injected.message, /needs an existing \.t3-supervisor\/steps\//u, "a global row cannot be written into the local index");
  const missing = yield* save({...localIndex(), steps: [...localIndex().steps, indexEntry("steps", "missing")]});
  assert.equal(missing.status, "invalid");
  assert.match(missing.message, /steps\/missing\.md needs an existing \.t3-supervisor\/steps\/missing\.md/u);
  const threeLines = yield* save({...localIndex(), steps: [{...localIndex().steps[0]!, summary: "One.\nTwo.\nThree."}, localIndex().steps[1]!]});
  assert.equal(threeLines.status, "invalid");
  assert.match(threeLines.message, /at most 2 nonempty lines/u);
  for (const path of ["steps/Local Step.md", "workflows/local-flow.yaml", "steps/local-step.yaml", "./steps/local-step.md"]) {
    const invalidPath = yield* save({...localIndex(), steps: [{...localIndex().steps[0]!, path}, localIndex().steps[1]!]});
    assert.equal(invalidPath.status, "invalid", path);
    assert.match(invalidPath.message, /path must be steps\/<id>\.md/u, path);
  }
  const duplicate = yield* save({...localIndex(), steps: [localIndex().steps[0]!, {...localIndex().steps[0]!, summary: "Run the check again."}]});
  assert.match(duplicate.message, /steps\/local-step\.md is indexed more than once/u);
  assert.equal((yield* save({...localIndex(), steps: [{id: "local-step", ...localIndex().steps[0]!}, localIndex().steps[1]!]})).status, "invalid", "an authored id is an unknown key");
  assert.equal((yield* save({required: [{step: "local-step"}]})).status, "invalid", "the old required list is not an accepted payload");
  const mixed = yield* save({...localIndex(), required: [{step: "local-step"}]});
  assert.equal(mixed.status, "invalid", "a legacy required list beside the index is rejected, not dropped");
  assert.match(mixed.message, /each entry's required flag/u);
  assert.equal((yield* save({...localIndex(), steps: [{...localIndex().steps[0]!, extra: true}, localIndex().steps[1]!]})).status, "invalid");
  assert.equal(f.writes.length, 0);

  const indexed = yield* save({...localIndex([{step: "new-step"}]), steps: [...localIndex().steps, indexEntry("steps", "new-step", true, "Check new behavior before release.")]});
  assert.equal(indexed.status, "saved", indexed.message);
  assert.equal(indexed.definitions?.status, "ready");
  assert.ok(indexed.definitions?.steps.some(step => step.id === "new-step" && step.summary === "Check new behavior before release."));
  assert.deepEqual(requiredReferences(indexed.definitions!.projectConfig!), [{step: "new-step"}]);
}));

it.live("reports definite permission and uncertain native write outcomes without retrying", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  seedProject(f);
  // the native write outcome is injected through a Ref: a definite refusal, a lost connection, or an accepted write that changed nothing
  const outcome = yield* Ref.make<"refused" | "disconnected" | "unapplied">("refused");
  let attempts = 0;
  const writer: ProjectWriter = {checkProjectConfigFile: f.writer.checkProjectConfigFile, writeProjectConfig: async () => {
    const injected = Ref.getUnsafe(outcome);
    if (injected === "refused") throw new ProjectFileError("permission_required", "write");
    attempts++;
    if (injected === "disconnected") throw new Error("connection closed");
  }};
  const {definitions: loader, editor} = yield* services(f.editorLayer(writer));
  const definitions = yield* loader.load(f.projectId);
  const input: ProjectConfigSave = {projectId: f.projectId, threadId: null, expectedRevision: definitions.revision!, config: localIndex([{step: "local-step"}])};
  assert.equal((yield* editor.save(input)).status, "permission_required");
  yield* Ref.set(outcome, "disconnected");
  assert.equal((yield* editor.save(input)).status, "uncertain");
  assert.equal(attempts, 1);
  yield* Ref.set(outcome, "unapplied");
  assert.equal((yield* editor.save(input)).status, "uncertain");
  assert.equal(attempts, 2);
}));

it.live("native project writer checks the regular project.yaml target and writes only its fixed path", () => Effect.gen(function* () {
  const server = yield* loopbackServer;
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
  const writer = makeProjectWriter(`http://127.0.0.1:${address.port}`, "fixture");
  const signal = AbortSignal.timeout(5000);
  assert.equal(yield* Effect.promise(() => writer.checkProjectConfigFile("/workspace", signal)), true);
  yield* Effect.promise(() => writer.writeProjectConfig("/workspace", "workflows: []\nsteps: []\n", signal));
  assert.equal(calls.filter(call => call.tag === "projects.writeFile").length, 1);
  assert.equal(calls.find(call => call.tag === "projects.writeFile")?.payload.relativePath, ".t3-supervisor/project.yaml");
  targetKind = "directory";
  assert.equal(yield* Effect.promise(() => writer.checkProjectConfigFile("/workspace", signal)), false);
  targetKind = "missing";
  assert.equal(yield* Effect.promise(() => writer.checkProjectConfigFile("/workspace", signal)), false);
}));

it.live("project-configuration endpoint keeps session, origin and CSRF checks", () => Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "project-config-api-"))),
    created => Effect.promise(() => rm(created, {recursive: true, force: true})));
  const f = makeDefinitionFixture();
  seedProject(f);
  // the dashboard server is not ported yet (S6c), so it serves the Promise facades of the loader and the editor
  const editor = f.editor(f.writer);
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0,
    uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: directory,
  };
  const ui = yield* Effect.acquireRelease(Effect.promise(() => startGuidanceUi(config, {} as GuidanceRuntime, f.loader, editor)), started => Effect.promise(() => started.close()));
  yield* Effect.promise(async () => {
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
    assert.equal((await fetch(origin + path).then(released)).status, 401);
    assert.equal((await fetch(origin + path, {headers: {...headers, Origin: "https://foreign.invalid"}}).then(released)).status, 403);
    const observedResponse = await fetch(origin + path, {headers});
    assert.equal(observedResponse.status, 200);
    const observed = await observedResponse.json() as {status: string; revision: string; projectConfig: unknown};
    assert.equal(observed.status, "ready");
    assert.ok(observed.revision);
    // the dashboard may omit a false required flag; only the required row carries it
    const compactRows = (rows: ReadonlyArray<{path: string; summary: string; required: boolean}>) =>
      rows.map(({required, ...row}) => required ? {...row, required} : row);
    const index = localIndex([{step: "local-step"}]);
    const payload = {projectId: "project", threadId: null, expectedRevision: observed.revision,
      config: {workflows: compactRows(index.workflows), steps: compactRows(index.steps)}};
    const rejected = await fetch(origin + "/api/guidance/project-configuration", {
      method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    assert.equal(rejected.status, 403);
    await released(rejected);
    assert.equal(f.writes.length, 0);
    const csrf = await fetch(origin + "/api/csrf", {headers}).then(response => response.json()) as {csrf: string};
    // legacy or unknown fields are rejected while decoding the request, before any normalization or write
    for (const config of [{...localIndex(), required: [{step: "local-step"}]}, {...localIndex(), steps: [{...localIndex().steps[0]!, extra: true}, localIndex().steps[1]!]},
      {...localIndex(), steps: [{id: "local-step", ...localIndex().steps[0]!}, localIndex().steps[1]!]}]) {
      const strict = await fetch(origin + "/api/guidance/project-configuration", {
        method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.csrf},
        body: JSON.stringify({...payload, config}),
      });
      assert.notEqual(strict.status, 200, JSON.stringify(config));
      await released(strict);
      assert.equal(f.writes.length, 0, "nothing is written for a request with an unknown field");
    }
    const saved = await fetch(origin + "/api/guidance/project-configuration", {
      method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.csrf}, body: JSON.stringify(payload),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as {status: string; definitions: {projectConfig: {steps: Array<{path: string; required: boolean}>; workflows: Array<{required: boolean}>}}};
    assert.equal(savedBody.status, "saved");
    assert.deepEqual(f.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
    assert.deepEqual(savedBody.definitions.projectConfig.steps.map(row => [row.path, row.required]), [["steps/local-step.md", true], ["steps/second-step.md", false]],
      "an omitted flag is saved and read back as false");
    assert.deepEqual(savedBody.definitions.projectConfig.workflows.map(row => row.required), [false]);
    const writtenIndex = f.writes[0]!.contents;
    assert.doesNotMatch(writtenIndex, /required: false/u);
    assert.equal(writtenIndex.match(/required: true/gu)?.length, 1);
    assert.doesNotMatch(writtenIndex, /\bid:/u, "the saved index is path-only");
  });
}));
