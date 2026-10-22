import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ProjectConfigEditorService } from "../src/project-config-editor.js";
import { decodeDefinitionSource, definitionStepSource, definitionWorkflowSource, ProjectConfigurationSource, ProjectDefinitions } from "../src/project-definitions.js";
import { ProjectFileError, type FreshGitInfo } from "../src/project-files.js";
import { asLoaderOptions, asProjectFiles, asProjectWriter, type ProjectDefinitionLoaderOptions, type ProjectFiles, type ProjectWriter } from "./support/native-files-promise.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

// target regressions of the ProjectDefinitions and ProjectConfigEditor services: interruption, soft cancellation, the Effect-clock deadline and the Schema source boundary

type Fixture = ReturnType<typeof makeDefinitionFixture>;
// the definitions service over the fixture's catalog and projection with replaced files or options
const definitionsLayer = (f: Fixture, replaced: {files?: ProjectFiles; options?: ProjectDefinitionLoaderOptions} = {}) =>
  ProjectDefinitions.layer({source: f.source, t3: f.t3, files: asProjectFiles(replaced.files ?? f.files), options: asLoaderOptions(replaced.options ?? f.loaderOptions)});
const serviceOf = <I, S>(layer: Layer.Layer<I>, tag: Context.Key<I, S>) => Effect.map(Layer.build(layer), context => Context.get(context, tag));

const seedCheck = (f: Fixture) => {
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows: []\nsteps:\n  - path: steps/check.md\n    summary: Check the change.\n");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", "---\nid: check\nname: check\ndescription: Inspect the changed behavior.\n---\n");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
};
// a native read of one path that hangs until its signal aborts and then fails as the native transport does
const hangingRead = (f: Fixture, hungPath: string) => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const files: ProjectFiles = {...f.files, read: (root, path, signal) => {
    if (path !== hungPath) return f.files.read(root, path, signal);
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {aborted.resolve();reject(new ProjectFileError("unavailable"));}, {once: true}));
  }};
  return {files, entered: entered.promise, aborted: aborted.promise};
};
const load = Effect.gen(function* () {
  const definitions = yield* ProjectDefinitions;
  return yield* definitions.load("project");
});

it.effect("TR-PD-01: the 30 s load deadline runs on the Effect clock and ends a hung read with the incomplete unavailable snapshot", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  seedCheck(f);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const fiber = yield* Effect.forkChild(load.pipe(Effect.provide(definitionsLayer(f, {files}))));
  yield* Effect.promise(() => entered);
  yield* TestClock.adjust("29999 millis");
  yield* Effect.yieldNow;
  assert.equal(fiber.pollUnsafe(), undefined, "the read is still pending one millisecond before the deadline");
  yield* TestClock.adjust("1 millis");
  const snapshot = yield* Fiber.join(fiber);
  assert.deepEqual({status: snapshot.status, complete: snapshot.complete, revision: snapshot.revision, issues: snapshot.issues}, {status: "unavailable", complete: false, revision: null,
    issues: [{path: ".t3-supervisor/steps/check.md", code: "definition_source_unreadable", message: "T3 project file access is unavailable."}]});
}), {timeout: 10_000});

it.effect("TR-PD-02: interrupting a load aborts its in-flight native read and yields no snapshot", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  seedCheck(f);
  const {files, entered, aborted} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const fiber = yield* Effect.forkChild(load.pipe(Effect.provide(definitionsLayer(f, {files}))));
  yield* Effect.promise(() => entered);
  yield* Fiber.interrupt(fiber);
  yield* Effect.promise(() => aborted);
  const exit = yield* Fiber.await(fiber);
  assert.ok(Exit.hasInterrupts(exit), "the interrupted load produced no snapshot");
}), {timeout: 10_000});

it.effect("TR-PD-03: interrupting create-and-commit setup before the second write leaves the first file uncommitted, never commits and releases the checkout lock", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  const secondWrite = Promise.withResolvers<void>();
  const commits: unknown[] = [];
  const options: ProjectDefinitionLoaderOptions = {...f.loaderOptions,
    setupWriter: {
      writeFile: async (root, path, contents, signal) => {
        if (path === ".t3-supervisor/project.yaml") {f.writes.push({root, path, contents});f.addFile(root, path, contents);return;}
        secondWrite.resolve();
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new ProjectFileError("unavailable", "write")), {once: true}));
      },
      commitFiles: async (...args) => {commits.push(args);return {status: "committed", commitSha: "never"};},
    },
    gitProbe: async (root): Promise<FreshGitInfo> => ({workspaceRoot: root, branch: "main", isRepo: true, changedPaths: f.writes.map(write => write.path), operationState: {status: "safe"}}),
  };
  const definitions = yield* serviceOf(definitionsLayer(f, {options}), ProjectDefinitions);
  const setup = {origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"} as const;
  const fiber = yield* Effect.forkChild(definitions.initialize("project", null, setup));
  yield* Effect.promise(() => secondWrite.promise);
  yield* Fiber.interrupt(fiber);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(fiber)));
  assert.deepEqual(f.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  assert.equal(f.trees.get("/workspace")?.has(".t3-supervisor/steps/.gitkeep"), false);
  assert.deepEqual(commits, []);
  // the interrupted setup released its checkout lock: the next setup of the same root runs and finds the partial folder
  const next = yield* definitions.initialize("project", null, {...setup, action: "create"});
  assert.deepEqual(next, {status: "conflict", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "The selected checkout already has a .t3-supervisor folder; no files were changed."});
}), {timeout: 10_000});

it.effect("TR-EDITOR-01: an interrupted save queued behind another leaves the queue, writes nothing and releases the checkout lock", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows:\n  - path: workflows/local-flow.yaml\n    summary: Run the local flow.\nsteps:\n  - path: steps/local-step.md\n    summary: Check the local behavior.\n");
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: local-step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  const firstWrite = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let writes = 0;
  const writer: ProjectWriter = {checkProjectConfigFile: f.writer.checkProjectConfigFile, writeProjectConfig: async (root, contents, signal) => {
    if (++writes === 1) {firstWrite.resolve();await releaseFirst.promise;}
    await f.writer.writeProjectConfig(root, contents, signal);
  }};
  const definitions = yield* serviceOf(definitionsLayer(f), ProjectDefinitions);
  // the editor's loads are counted so the test knows when the second save has its snapshot and waits for the lock
  const loaded = yield* Deferred.make<void>();
  let loads = 0;
  const editor = yield* ProjectConfigEditorService.make({writer: asProjectWriter(writer), definitions: {...definitions,
    load: (...args) => definitions.load(...args).pipe(Effect.tap(() => ++loads === 3 ? Deferred.succeed(loaded, undefined) : Effect.void))}});
  const input = (revision: string, summary: string): ProjectConfigSave => ({projectId: "project", threadId: null, expectedRevision: revision, config: {
    workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
    steps: [{path: "steps/local-step.md", summary, required: false}],
  }});
  const revision = (yield* definitions.load("project")).revision!;
  const first = yield* Effect.forkChild(editor.save(input(revision, "First draft.")));
  yield* Effect.promise(() => firstWrite.promise);
  const second = yield* Effect.forkChild(editor.save(input(revision, "Cancelled draft.")));
  yield* Deferred.await(loaded);
  yield* Effect.yieldNow;
  yield* Fiber.interrupt(second);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(second)));
  releaseFirst.resolve();
  const saved = yield* Fiber.join(first);
  assert.equal(saved.status, "saved", saved.message);
  const next = yield* editor.save(input(saved.definitions!.revision!, "Next draft."));
  assert.equal(next.status, "saved", next.message);
  assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(write => !write.contents.includes("Cancelled draft")));
}), {timeout: 10_000});

it.effect("TR-PD-05: a cancel signal ends a load and a setup softly, so the service itself settles with the unavailable snapshot and the stale setup", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  seedCheck(f);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const hung = yield* serviceOf(definitionsLayer(f, {files}), ProjectDefinitions);
  const cancelLoad = new AbortController();
  const loading = yield* Effect.forkChild(hung.load("project", null, cancelLoad.signal));
  yield* Effect.promise(() => entered);
  cancelLoad.abort();
  const snapshot = yield* Fiber.join(loading);
  assert.deepEqual({status: snapshot.status, complete: snapshot.complete, revision: snapshot.revision, issues: snapshot.issues}, {status: "unavailable", complete: false, revision: null,
    issues: [{path: ".t3-supervisor/steps/check.md", code: "definition_source_unreadable", message: "T3 project file access is unavailable."}]});

  const g = makeDefinitionFixture({threadRoot: null});
  const cancelSetup = new AbortController();
  const commits: unknown[] = [];
  const definitions = yield* serviceOf(definitionsLayer(g, {options: {...g.loaderOptions,
    setupWriter: {
      writeFile: async (root, path, contents) => {g.writes.push({root, path, contents});g.addFile(root, path, contents);cancelSetup.abort();},
      commitFiles: async (...args) => {commits.push(args);return {status: "committed", commitSha: "never"};},
    },
    gitProbe: async (root): Promise<FreshGitInfo> => ({workspaceRoot: root, branch: "main", isRepo: true, changedPaths: g.writes.map(write => write.path), operationState: {status: "safe"}}),
  }}), ProjectDefinitions);
  const outcome = yield* definitions.initialize("project", null, {origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"}, cancelSetup.signal);
  assert.deepEqual(outcome, {status: "stale", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor", message: "Setup was canceled; files created so far were left uncommitted."});
  assert.deepEqual(g.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  assert.deepEqual(commits, []);
}), {timeout: 10_000});

it.effect("TR-EDITOR-02: a save whose cancel signal aborts while it is queued waits its turn, then the service reports the expired save and writes nothing", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows:\n  - path: workflows/local-flow.yaml\n    summary: Run the local flow.\nsteps:\n  - path: steps/local-step.md\n    summary: Check the local behavior.\n");
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: local-step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  const firstWrite = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let writes = 0;
  const writer: ProjectWriter = {checkProjectConfigFile: f.writer.checkProjectConfigFile, writeProjectConfig: async (root, contents, signal) => {
    if (++writes === 1) {firstWrite.resolve();await releaseFirst.promise;}
    await f.writer.writeProjectConfig(root, contents, signal);
  }};
  const definitions = yield* serviceOf(definitionsLayer(f), ProjectDefinitions);
  const loaded = yield* Deferred.make<void>();
  let loads = 0;
  const editor = yield* ProjectConfigEditorService.make({writer: asProjectWriter(writer), definitions: {...definitions,
    load: (...args) => definitions.load(...args).pipe(Effect.tap(() => ++loads === 3 ? Deferred.succeed(loaded, undefined) : Effect.void))}});
  const input = (revision: string, summary: string): ProjectConfigSave => ({projectId: "project", threadId: null, expectedRevision: revision, config: {
    workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
    steps: [{path: "steps/local-step.md", summary, required: false}],
  }});
  const revision = (yield* definitions.load("project")).revision!;
  const first = yield* Effect.forkChild(editor.save(input(revision, "First draft.")));
  yield* Effect.promise(() => firstWrite.promise);
  const cancel = new AbortController();
  const second = yield* Effect.forkChild(editor.save(input(revision, "Cancelled draft."), cancel.signal));
  yield* Deferred.await(loaded);
  cancel.abort();
  yield* Effect.yieldNow;
  assert.equal(second.pollUnsafe(), undefined, "the cancelled save still waits for the save ahead of it");
  releaseFirst.resolve();
  assert.equal((yield* Fiber.join(first)).status, "saved");
  assert.deepEqual(yield* Fiber.join(second), {status: "unavailable", message: "The save expired before writing. Refresh the project configuration.", definitions: null});
  assert.equal(loads, 4, "the expired save loaded nothing after its turn came");
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes.every(write => !write.contents.includes("Cancelled draft")));
}), {timeout: 10_000});

const rejects = <A>(schema: Schema.Codec<A, string>, contents: string, problem: string) => Effect.gen(function* () {
  const failure = yield* Effect.flip(decodeDefinitionSource(schema, contents));
  assert.equal(failure._tag, "DefinitionSourceInvalid");
  assert.equal(failure.problem, problem, contents);
});

it.effect("TR-PD-04: authored sources are Schema-decoded from YAML, and a rejected source fails with the validator's exact first message", () => Effect.gen(function* () {
  assert.deepEqual(yield* decodeDefinitionSource(ProjectConfigurationSource, "workflows: []\nsteps:\n  - path: steps/check.md\n    summary: \" Check it. \"\n"),
    {workflows: [], steps: [{path: "steps/check.md", summary: "Check it.", required: false}]});
  assert.deepEqual(yield* decodeDefinitionSource(definitionStepSource("check"), "﻿---\nid: check\nname: Check\ndescription: Inspect it.\n---\n"),
    {id: "check", name: "Check", description: "Inspect it."});
  assert.deepEqual(yield* decodeDefinitionSource(definitionWorkflowSource("flow"), "name: Flow\ndescription: Run it.\nparallel:\n  - step: check\n"),
    {id: "flow", name: "Flow", description: "Run it.", fixed: false, parallel: [{step: "check"}]});
  yield* rejects(ProjectConfigurationSource, "workflows: [\n", "Invalid YAML; check syntax, duplicate keys and tags.");
  yield* rejects(ProjectConfigurationSource, "workflows: &shared []\nsteps: *shared\n", "YAML aliases are not supported in project definitions.");
  yield* rejects(ProjectConfigurationSource, "workflows: []\nsteps: []\nextra: true\n", "project.yaml needs workflows and steps lists (use [] for none) and an optional default_workflow identifier.");
  yield* rejects(ProjectConfigurationSource, "workflows: []\nsteps:\n  - {path: steps/check.md, summary: Check it., extra: 1}\n", "Each steps entry needs exactly path, summary and optional required (true or false).");
  // the filename is checked before the frontmatter, the frontmatter YAML before its fields and the fields before the body
  yield* rejects(definitionStepSource("../check"), "not a step", "Invalid step filename.");
  yield* rejects(definitionStepSource("check"), "not a step", "Step needs YAML frontmatter containing id, name and description.");
  yield* rejects(definitionStepSource("check"), "---\nid: [\n---\n", "Invalid YAML; check syntax, duplicate keys and tags.");
  yield* rejects(definitionStepSource("check"), "---\nid: other\nname: Check\ndescription: Inspect it.\n---\nBody.\n",
    "Step frontmatter needs a matching id, name, nonempty description and optional references: a list of relative file paths.");
  yield* rejects(definitionStepSource("check"), "---\nid: check\nname: Check\ndescription: Inspect it.\n---\nBody.\n", "Step body must be empty; keep all guidance in description.");
  yield* rejects(definitionWorkflowSource("Flow"), "workflows: [", "Invalid workflow filename.");
  yield* rejects(definitionWorkflowSource("flow"), "name: Flow\ndescription: Run it.\nsequence: []\n", "sequence must contain at least one workflow node.");
}), {timeout: 10_000});
