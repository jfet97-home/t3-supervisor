import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ProjectConfigEditorService, type ProjectConfigWriter } from "../src/project-config-editor.js";
import {
  decodeDefinitionSource, definitionStepSource, definitionWorkflowSource, ProjectConfigurationSource, type ProjectDefinitionLoaderOptions,
} from "../src/project-definitions.js";
import { ProjectFileError, type FreshGitInfo, type ProjectFiles } from "../src/project-files.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

// target regressions of the ProjectDefinitions and ProjectConfigEditor services: interruption, soft cancellation, the Effect-clock deadline and the Schema source boundary

type Fixture = ReturnType<typeof makeDefinitionFixture>;

const seedCheck = (f: Fixture) => {
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows: []\nsteps:\n  - path: steps/check.md\n    summary: Check the change.\n");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", "---\nid: check\nname: check\ndescription: Inspect the changed behavior.\n---\n");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
};
// a native read of one path that hangs until its cancel trigger completes and then fails as the native transport does (a read
// without a trigger gets one that never completes); aborted completes once that read is interrupted
const hangingRead = (f: Fixture, hungPath: string) => {
  const entered = Deferred.makeUnsafe<void>();
  const aborted = Deferred.makeUnsafe<void>();
  const files: ProjectFiles["Service"] = {...f.projectFiles, read: (root, path, cancel = Deferred.makeUnsafe<void>()) => path !== hungPath
    ? f.projectFiles.read(root, path)
    : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(cancel)), Effect.andThen(Effect.fail(new ProjectFileError("unavailable"))),
      Effect.onInterrupt(() => Deferred.succeed(aborted, undefined)))};
  return {files, entered: Deferred.await(entered), aborted: Deferred.await(aborted)};
};
// a project writer whose first project.yaml write waits for release
const heldWriter = (f: Fixture) => {
  const firstWrite = Deferred.makeUnsafe<void>();
  const releaseFirst = Deferred.makeUnsafe<void>();
  let writes = 0;
  const writer: ProjectConfigWriter = {checkProjectConfigFile: f.projectWriter.checkProjectConfigFile, writeProjectConfig: (root, contents) => Effect.gen(function* () {
    if (++writes === 1) {yield* Deferred.succeed(firstWrite, undefined);yield* Deferred.await(releaseFirst);}
    yield* f.projectWriter.writeProjectConfig(root, contents);
  })};
  return {writer, firstWrite: Deferred.await(firstWrite), release: Deferred.succeed(releaseFirst, undefined)};
};

it.effect("TR-PD-01: the 30 s load deadline runs on the Effect clock and ends a hung read with the incomplete unavailable snapshot", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  seedCheck(f);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const definitions = yield* f.makeDefinitions({files});
  const fiber = yield* Effect.forkChild(definitions.load("project"));
  yield* entered;
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
  const definitions = yield* f.makeDefinitions({files});
  const fiber = yield* Effect.forkChild(definitions.load("project"));
  yield* entered;
  yield* Fiber.interrupt(fiber);
  yield* aborted;
  const exit = yield* Fiber.await(fiber);
  assert.ok(Exit.hasInterrupts(exit), "the interrupted load produced no snapshot");
}), {timeout: 10_000});

it.effect("TR-PD-03: interrupting create-and-commit setup before the second write leaves the first file uncommitted, never commits and releases the checkout lock", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  const secondWrite = Deferred.makeUnsafe<void>();
  const commits: unknown[] = [];
  // the second setup write hangs until its cancel trigger completes and then fails as the native transport does
  const options: ProjectDefinitionLoaderOptions = {...f.definitionOptions,
    setupWriter: {
      writeFile: (root, path, contents, cancel = Deferred.makeUnsafe<void>()) => path === ".t3-supervisor/project.yaml"
        ? Effect.sync(() => {f.writes.push({root, path, contents});f.addFile(root, path, contents);})
        : Deferred.succeed(secondWrite, undefined).pipe(Effect.andThen(Deferred.await(cancel)), Effect.andThen(Effect.fail(new ProjectFileError("unavailable", "write")))),
      commitFiles: (...args) => Effect.sync(() => {commits.push(args);return {status: "committed" as const, commitSha: "never"};}),
    },
    gitProbe: root => Effect.sync((): FreshGitInfo => ({workspaceRoot: root, branch: "main", isRepo: true, changedPaths: f.writes.map(write => write.path), operationState: {status: "safe"}})),
  };
  const definitions = yield* f.makeDefinitions({options});
  const setup = {origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"} as const;
  const fiber = yield* Effect.forkChild(definitions.initialize("project", null, setup));
  yield* Deferred.await(secondWrite);
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
  const {writer, firstWrite, release} = heldWriter(f);
  const definitions = yield* f.makeDefinitions();
  // the editor's loads are counted so the test knows when the second save has its snapshot and waits for the lock
  const loaded = yield* Deferred.make<void>();
  let loads = 0;
  const editor = yield* ProjectConfigEditorService.make({writer, definitions: {...definitions,
    load: (...args) => definitions.load(...args).pipe(Effect.tap(() => ++loads === 3 ? Deferred.succeed(loaded, undefined) : Effect.void))}});
  const input = (revision: string, summary: string): ProjectConfigSave => ({projectId: "project", threadId: null, expectedRevision: revision, config: {
    workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
    steps: [{path: "steps/local-step.md", summary, required: false}],
  }});
  const revision = (yield* definitions.load("project")).revision!;
  const first = yield* Effect.forkChild(editor.save(input(revision, "First draft.")));
  yield* firstWrite;
  const second = yield* Effect.forkChild(editor.save(input(revision, "Cancelled draft.")));
  yield* Deferred.await(loaded);
  yield* Effect.yieldNow;
  yield* Fiber.interrupt(second);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(second)));
  yield* release;
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
  const hung = yield* f.makeDefinitions({files});
  // the caller's cancel trigger is the definitions' soft cancellation: a cancelled load or setup settles with its outcome
  const cancelLoad = yield* Deferred.make<void>();
  const loading = yield* Effect.forkChild(hung.load("project", null, cancelLoad));
  yield* entered;
  yield* Deferred.succeed(cancelLoad, undefined);
  const snapshot = yield* Fiber.join(loading);
  assert.deepEqual({status: snapshot.status, complete: snapshot.complete, revision: snapshot.revision, issues: snapshot.issues}, {status: "unavailable", complete: false, revision: null,
    issues: [{path: ".t3-supervisor/steps/check.md", code: "definition_source_unreadable", message: "T3 project file access is unavailable."}]});

  const g = makeDefinitionFixture({threadRoot: null});
  const cancelSetup = yield* Deferred.make<void>();
  const commits: unknown[] = [];
  const definitions = yield* g.makeDefinitions({options: {...g.definitionOptions,
    setupWriter: {
      writeFile: (root, path, contents) => Effect.andThen(Effect.sync(() => {g.writes.push({root, path, contents});g.addFile(root, path, contents);}),
        Deferred.succeed(cancelSetup, undefined)),
      commitFiles: (...args) => Effect.sync(() => {commits.push(args);return {status: "committed" as const, commitSha: "never"};}),
    },
    gitProbe: root => Effect.sync((): FreshGitInfo => ({workspaceRoot: root, branch: "main", isRepo: true, changedPaths: g.writes.map(write => write.path), operationState: {status: "safe"}})),
  }});
  const outcome = yield* definitions.initialize("project", null, {origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"}, cancelSetup);
  assert.deepEqual(outcome, {status: "stale", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor", message: "Setup was canceled; files created so far were left uncommitted."});
  assert.deepEqual(g.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  assert.deepEqual(commits, []);
}), {timeout: 10_000});

it.effect("TR-EDITOR-02: a save whose cancel signal aborts while it is queued waits its turn, then the service reports the expired save and writes nothing", () => Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows:\n  - path: workflows/local-flow.yaml\n    summary: Run the local flow.\nsteps:\n  - path: steps/local-step.md\n    summary: Check the local behavior.\n");
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: local-step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  const {writer, firstWrite, release} = heldWriter(f);
  const definitions = yield* f.makeDefinitions();
  const loaded = yield* Deferred.make<void>();
  let loads = 0;
  const editor = yield* ProjectConfigEditorService.make({writer, definitions: {...definitions,
    load: (...args) => definitions.load(...args).pipe(Effect.tap(() => ++loads === 3 ? Deferred.succeed(loaded, undefined) : Effect.void))}});
  const input = (revision: string, summary: string): ProjectConfigSave => ({projectId: "project", threadId: null, expectedRevision: revision, config: {
    workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
    steps: [{path: "steps/local-step.md", summary, required: false}],
  }});
  const revision = (yield* definitions.load("project")).revision!;
  const first = yield* Effect.forkChild(editor.save(input(revision, "First draft.")));
  yield* firstWrite;
  const cancel = yield* Deferred.make<void>();
  const second = yield* Effect.forkChild(editor.save(input(revision, "Cancelled draft."), cancel));
  yield* Deferred.await(loaded);
  yield* Deferred.succeed(cancel, undefined);
  yield* Effect.yieldNow;
  assert.equal(second.pollUnsafe(), undefined, "the cancelled save still waits for the save ahead of it");
  yield* release;
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
    "Step frontmatter needs a matching id, name, nonempty description and optional references: relative file paths or explicit skill references.");
  yield* rejects(definitionStepSource("check"), "---\nid: check\nname: Check\ndescription: Inspect it.\n---\nBody.\n", "Step body must be empty; keep all guidance in description.");
  yield* rejects(definitionWorkflowSource("Flow"), "workflows: [", "Invalid workflow filename.");
  yield* rejects(definitionWorkflowSource("flow"), "name: Flow\ndescription: Run it.\nsequence: []\n", "sequence must contain at least one workflow node.");
}), {timeout: 10_000});
