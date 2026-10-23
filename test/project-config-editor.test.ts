import assert from "node:assert/strict";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {Context, Deferred, Effect, FileSystem, Fiber, Layer, Redacted, Ref} from "effect";
import {FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, type HttpClientError, type HttpClientResponse} from "effect/http";
import {createServer} from "node:http";
import {WebSocketServer} from "ws";
import {NativeEnvelope} from "../src/native-envelope.js";
import {ProjectConfigEditorService, type ProjectConfigWriter} from "../src/project-config-editor.js";
import {ProjectDefinitions} from "../src/project-definitions.js";
import type {ProjectConfigSave} from "../src/project-definitions-contract.js";
import {ProjectFileError, ProjectWriter} from "../src/project-files.js";
import {forgeDashboardToken} from "../src/service-auth.js";
import {cancelAfter, within} from "./support/g5a-bounds.js";
import {guidanceUi} from "./support/service-auth-harness.js";
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
// the dashboard's http boundary over the effect http client: each exchange owns its request in its own scope from the request
// through the reading of its body; an interruption or a failure at any point, or the end of the exchange, aborts the request,
// so no loopback request outlives its exchange and an unread body is released
interface Init {readonly method?: "GET" | "POST"; readonly headers?: Record<string, string>; readonly body?: string}
const exchange = <A>(url: string, init: Init,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, HttpClientError.HttpClientError>) => Effect.scoped(Effect.gen(function* () {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const request = HttpClientRequest.make(init.method ?? "GET")(url, {headers: init.headers ?? {},
    ...(init.body === undefined ? {} : {body: HttpBody.text(init.body, "application/json")})});
  return yield* read(yield* client.execute(request));
}));
// the status of a response whose body is released unread
const status = (url: string, init: Init = {}) => exchange(url, init, response => Effect.succeed(response.status));
// the status and the json body of a response
const json = <A>(url: string, init: Init = {}) => exchange(url, init, response => Effect.map(response.json, body => ({status: response.status, body: body as A})));
// a real loopback socket; the finalizer terminates its clients and closes it
const loopbackServer = Effect.acquireRelease(Effect.promise(async () => {
  const listening = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => listening.once("listening", resolve));
  return listening;
}), listening => Effect.promise(() => {
  for (const client of listening.clients) client.terminate();
  return new Promise<void>(resolve => listening.close(() => resolve()));
}));

it.effect("saves only local project.yaml, preserves valid YAML comments and retains global policy", () => Effect.gen(function* () {
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
  const {definitions, editor} = yield* services(f.configEditorLayer(f.projectWriter, definitions => Effect.sync(() => {savedSnapshotRevision = definitions.revision ?? undefined;})));
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

it.effect("indexes an existing unlisted file and rejects stale, missing-file, global, malformed or old-format indexes before writing", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({globalEnabled: true});
  seedProject(f);
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml", indexSource({steps: ["shared"]}));
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared.md", stepSource("shared"));
  f.addDirectory(f.globalRoot, ".t3-supervisor/workflows");
  const {definitions, editor} = yield* services(f.configEditorLayer());
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

it.effect("reports definite permission and uncertain native write outcomes without retrying", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  seedProject(f);
  // the native write outcome is injected through a Ref: a definite refusal, a lost connection (which the native writer reports as
  // its unconfirmed unavailable failure), or an accepted write that changed nothing
  const outcome = yield* Ref.make<"refused" | "disconnected" | "unapplied">("refused");
  let attempts = 0;
  const writer: ProjectConfigWriter = {checkProjectConfigFile: f.projectWriter.checkProjectConfigFile, writeProjectConfig: () => Effect.gen(function* () {
    const injected = yield* Ref.get(outcome);
    if (injected === "refused") return yield* new ProjectFileError("permission_required", "write");
    attempts++;
    if (injected === "disconnected") return yield* new ProjectFileError("unavailable", "write");
  })};
  const {definitions: loader, editor} = yield* services(f.configEditorLayer(writer));
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
  const writer = yield* ProjectWriter.make({baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture"}).pipe(Effect.provide(NativeEnvelope.layer));
  // the calls share one cancel trigger that completes after 5 s
  const cancel = yield* cancelAfter("5 seconds");
  assert.equal(yield* writer.checkProjectConfigFile("/workspace", cancel), true);
  yield* writer.writeProjectConfig("/workspace", "workflows: []\nsteps: []\n", cancel);
  assert.equal(calls.filter(call => call.tag === "projects.writeFile").length, 1);
  assert.equal(calls.find(call => call.tag === "projects.writeFile")?.payload.relativePath, ".t3-supervisor/project.yaml");
  targetKind = "directory";
  assert.equal(yield* writer.checkProjectConfigFile("/workspace", cancel), false);
  targetKind = "missing";
  assert.equal(yield* writer.checkProjectConfigFile("/workspace", cancel), false);
}));

it.live("project-configuration endpoint keeps session, origin and CSRF checks", () => Effect.gen(function* () {
  const directory = yield* FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.makeTempDirectoryScoped({prefix: "project-config-api-"})), Effect.provide(NodeFileSystem.layer));
  const f = makeDefinitionFixture();
  seedProject(f);
  // the dashboard's api handlers yield the definitions and the editor over the in-memory checkout
  const definitions = yield* f.makeDefinitions();
  const editor = yield* f.makeConfigEditor(definitions);
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0,
    uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: directory,
  };
  const ui = yield* guidanceUi(config, {} as GuidanceRuntime["Service"], {definitions, editor});
  assert.ok(ui.port > 0);
  const origin = `http://127.0.0.1:${ui.port}`;
  const grant = yield* forgeDashboardToken(directory).pipe(Effect.provide(NodeFileSystem.layer));
  const login = yield* json<{session: string}>(origin + "/auth/login", {
    method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify({token: Redacted.value(grant.token)}),
  });
  assert.equal(login.status, 200);
  const session = login.body.session;
  const headers = {"x-supervisor-session": session};
  const path = "/api/guidance/project-configuration?projectId=project";
  assert.equal(yield* status(origin + path), 401);
  assert.equal(yield* status(origin + path, {headers: {...headers, Origin: "https://foreign.invalid"}}), 403);
  const observedResponse = yield* json<{status: string; revision: string; projectConfig: unknown}>(origin + path, {headers});
  assert.equal(observedResponse.status, 200);
  const observed = observedResponse.body;
  assert.equal(observed.status, "ready");
  assert.ok(observed.revision);
  // the dashboard may omit a false required flag; only the required row carries it
  const compactRows = (rows: ReadonlyArray<{path: string; summary: string; required: boolean}>) =>
    rows.map(({required, ...row}) => required ? {...row, required} : row);
  const index = localIndex([{step: "local-step"}]);
  const payload = {projectId: "project", threadId: null, expectedRevision: observed.revision,
    config: {workflows: compactRows(index.workflows), steps: compactRows(index.steps)}};
  const rejected = yield* status(origin + "/api/guidance/project-configuration", {
    method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify(payload),
  });
  assert.equal(rejected, 403);
  assert.equal(f.writes.length, 0);
  const csrf = (yield* json<{csrf: string}>(origin + "/api/csrf", {headers})).body;
  // legacy or unknown fields are rejected while decoding the request, before any normalization or write
  for (const config of [{...localIndex(), required: [{step: "local-step"}]}, {...localIndex(), steps: [{...localIndex().steps[0]!, extra: true}, localIndex().steps[1]!]},
    {...localIndex(), steps: [{id: "local-step", ...localIndex().steps[0]!}, localIndex().steps[1]!]}]) {
    const strict = yield* status(origin + "/api/guidance/project-configuration", {
      method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.csrf},
      body: JSON.stringify({...payload, config}),
    });
    assert.notEqual(strict, 200, JSON.stringify(config));
    assert.equal(f.writes.length, 0, "nothing is written for a request with an unknown field");
  }
  const saved = yield* json<{status: string; definitions: {projectConfig: {steps: Array<{path: string; required: boolean}>; workflows: Array<{required: boolean}>}}}>(origin + "/api/guidance/project-configuration", {
    method: "POST", headers: {...headers, Origin: origin, "Content-Type": "application/json", "x-csrf-token": csrf.csrf}, body: JSON.stringify(payload),
  });
  assert.equal(saved.status, 200);
  const savedBody = saved.body;
  assert.equal(savedBody.status, "saved");
  assert.deepEqual(f.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  assert.deepEqual(savedBody.definitions.projectConfig.steps.map(row => [row.path, row.required]), [["steps/local-step.md", true], ["steps/second-step.md", false]],
    "an omitted flag is saved and read back as false");
  assert.deepEqual(savedBody.definitions.projectConfig.workflows.map(row => row.required), [false]);
  const writtenIndex = f.writes[0]!.contents;
  assert.doesNotMatch(writtenIndex, /required: false/u);
  assert.equal(writtenIndex.match(/required: true/gu)?.length, 1);
  assert.doesNotMatch(writtenIndex, /\bid:/u, "the saved index is path-only");
}).pipe(Effect.provide(FetchHttpClient.layer)));

// a loopback peer that receives one request and holds it: without headers, or after the headers and an incomplete json body;
// it reports the request's arrival and the end of its connection, and closes every connection at teardown
const heldPeer = (hold: "headers" | "body") => Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const server = yield* Effect.acquireRelease(Effect.promise(() => new Promise<ReturnType<typeof createServer>>(resolve => {
    const listening = createServer((request, response) => {
      request.socket.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
      if (hold === "body") {
        response.writeHead(200, {"content-type": "application/json"});
        response.write("{\"partial\":");
      }
      Deferred.doneUnsafe(arrived, Effect.void);
    });
    listening.listen(0, "127.0.0.1", () => resolve(listening));
  })), listening => Effect.promise(() => {
    listening.closeAllConnections();
    return new Promise<void>(resolve => listening.close(() => resolve()));
  }));
  const address = server.address();
  return {url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/held`, arrived, closed};
});

it.live("A-R33-G5-01: an exchange interrupted while it waits for the response headers ends its loopback request before the peer's teardown", () => Effect.gen(function* () {
  const peer = yield* heldPeer("headers");
  const fiber = yield* Effect.forkChild(status(peer.url));
  yield* within(Deferred.await(peer.arrived), 5_000, "the held request");
  yield* Fiber.interrupt(fiber);
  yield* within(Deferred.await(peer.closed), 2_000, "interrupting the headers adapter must close its request before server teardown");
}).pipe(Effect.provide(FetchHttpClient.layer)));

it.live("A-R33-G5-01: an exchange interrupted while it reads an incomplete json body ends its loopback request before the peer's teardown", () => Effect.gen(function* () {
  const peer = yield* heldPeer("body");
  // the json helper's read, entered after the headers arrived
  const reading = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(exchange(peer.url, {}, response => Effect.andThen(Deferred.succeed(reading, undefined), response.json)));
  yield* within(Deferred.await(reading), 5_000, "the body read");
  yield* Fiber.interrupt(fiber);
  yield* within(Deferred.await(peer.closed), 2_000, "interrupting the body adapter must close its request before server teardown");
}).pipe(Effect.provide(FetchHttpClient.layer)));
