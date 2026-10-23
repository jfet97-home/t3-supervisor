import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { ProjectDefinitionLoaderOptions, ProjectDefinitionSetupWriter } from "../src/project-definitions.js";
import type { ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import { ProjectFileError, type FreshGitInfo, type ProjectFiles } from "../src/project-files.js";
import { within } from "./support/g5a-bounds.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

type Fixture = ReturnType<typeof makeDefinitionFixture>;
const setup = {origin: "project", action: "create", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"} as const;

// the definitions over the fixture's in-memory files, or the given ones, with a setup writer and git probe the test controls,
// in the test's scope
const definitionsWith = (f: Fixture, options: {
  files?: ProjectFiles["Service"];
  writeFile?: ProjectDefinitionSetupWriter["writeFile"];
  commitFiles?: ProjectDefinitionSetupWriter["commitFiles"];
  gitProbe?: ProjectDefinitionLoaderOptions["gitProbe"];
} = {}) => f.makeDefinitions({files: options.files ?? f.projectFiles, options: {
  globalRoot: f.globalRoot,
  useGlobalDefinitions: () => Effect.succeed(false),
  isScratchProject: () => Effect.succeed(false),
  setupWriter: {
    writeFile: options.writeFile ?? ((root, path, contents) => Effect.sync(() => {f.writes.push({root, path, contents});f.addFile(root, path, contents);})),
    ...(options.commitFiles ? {commitFiles: options.commitFiles} : {}),
  },
  ...(options.gitProbe ? {gitProbe: options.gitProbe} : {}),
}});

it.effect("CT-PD-01: two concurrent initialize() calls for one checkout write the three scaffold files once; the second reports the existing folder", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  const events: string[] = [];
  const definitions = yield* definitionsWith(f, {writeFile: (root, path, contents) => Effect.gen(function* () {
    events.push(`write:${path}`);
    yield* Effect.yieldNow;
    f.writes.push({root, path, contents});
    f.addFile(root, path, contents);
  })});
  const [first, second] = yield* within(Effect.all([
    definitions.initialize("project", null, setup),
    definitions.initialize("project", null, setup),
  ], {concurrency: "unbounded"}), 5_000, "both setups");
  assert.deepEqual(first, {status: "created", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "Created project.yaml, steps/.gitkeep and workflows/.gitkeep; all files are uncommitted."});
  assert.deepEqual(second, {status: "conflict", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "The selected checkout already has a .t3-supervisor folder; no files were changed."});
  assert.deepEqual(events, ["write:.t3-supervisor/project.yaml", "write:.t3-supervisor/steps/.gitkeep", "write:.t3-supervisor/workflows/.gitkeep"]);
  assert.deepEqual(f.writes.map(write => [write.path, write.contents]), [
    [".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n"], [".t3-supervisor/steps/.gitkeep", ""], [".t3-supervisor/workflows/.gitkeep", ""],
  ]);
}), {timeout: 10_000});

// a native read that hangs until its cancel trigger completes and then fails as the native transport does; entered hands out
// that read's trigger (a read without one gets a trigger that never completes)
const hangingRead = (f: Fixture, hungPath: string) => {
  const entered = Deferred.makeUnsafe<Deferred.Deferred<void>>();
  const files: ProjectFiles["Service"] = {...f.projectFiles, read: (root, path, cancel = Deferred.makeUnsafe<void>()) => path !== hungPath
    ? f.projectFiles.read(root, path)
    : Deferred.succeed(entered, cancel).pipe(Effect.andThen(Deferred.await(cancel)), Effect.andThen(Effect.fail(new ProjectFileError("unavailable"))))};
  return {files, entered: Deferred.await(entered)};
};

const seed = (f: Fixture) => {
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows: []\nsteps:\n  - path: steps/check.md\n    summary: Check the change.\n");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", "---\nid: check\nname: check\ndescription: Inspect the changed behavior.\n---\n");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
};

const unavailableSnapshot = {status: "unavailable", complete: false, revision: null,
  issues: [{path: ".t3-supervisor/steps/check.md", code: "definition_source_unreadable", message: "T3 project file access is unavailable."}]};
const summary = (snapshot: ProjectDefinitionSnapshot) =>
  ({status: snapshot.status, complete: snapshot.complete, revision: snapshot.revision, issues: snapshot.issues});

// the effect clock advances in 100 ms steps, as real time passed for the baseline, until the fiber settles; past the bound it dies
// naming the awaited event
const settledWithin = <A>(fiber: Fiber.Fiber<A>, milliseconds: number, label: string): Effect.Effect<A> => Effect.gen(function* () {
  for (let elapsed = 0; fiber.pollUnsafe() === undefined; elapsed += 100) {
    if (elapsed >= milliseconds) return yield* Effect.die(new Error(`timed out waiting for ${label}`));
    yield* TestClock.adjust("100 millis");
  }
  return yield* Fiber.join(fiber);
});

it.effect("CT-PD-02: a hung native read ends when the caller aborts, giving an incomplete unavailable snapshot without a revision", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  seed(f);
  assert.equal((yield* (yield* f.makeDefinitions()).load("project")).complete, true);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const definitions = yield* definitionsWith(f, {files});
  // the caller's cancel trigger is the definitions' soft cancellation: a cancelled load settles with its snapshot
  const cancel = yield* Deferred.make<void>();
  const pending = yield* Effect.forkChild(definitions.load("project", null, cancel));
  const trigger = yield* within(entered, 5_000, "hung read");
  assert.equal(yield* Deferred.isDone(trigger), false);
  yield* Deferred.succeed(cancel, undefined);
  assert.deepEqual(summary(yield* within(Fiber.join(pending), 5_000, "aborted load")), unavailableSnapshot);
}), {timeout: 10_000});

it.effect("CT-PD-02: without a caller signal the hard-coded 30 s load deadline ends a hung read with the same unavailable snapshot", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  seed(f);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const definitions = yield* definitionsWith(f, {files});
  const started = yield* Clock.currentTimeMillis;
  const pending = yield* Effect.forkChild(definitions.load("project"));
  yield* within(entered, 5_000, "hung read");
  const snapshot = yield* settledWithin(pending, 45_000, "load deadline");
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  assert.deepEqual(summary(snapshot), unavailableSnapshot);
  assert.ok(elapsed >= 29_900 && elapsed < 40_000, `deadline after ${Math.round(elapsed)} ms`);
}), {timeout: 10_000});

it.effect("CT-PD-03: a fixture tree yields the golden revision, global revision and namespaced global IDs", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({globalEnabled: true});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml",
    "workflows:\n  - path: workflows/shared-flow.yaml\n    summary: Run the shared flow.\nsteps:\n  - path: steps/shared-step.md\n    summary: Run the shared step.\n    required: true\ndefault_workflow: shared-flow\n");
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared-step.md", "---\nid: shared-step\nname: Shared step\ndescription: Check shared behavior.\n---\n");
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/shared-flow.yaml", "name: Shared flow\ndescription: Shared flow workflow.\nsequence:\n  - step: shared-step\n");
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows:\n  - path: workflows/local-flow.yaml\n    summary: Run the local flow.\nsteps:\n  - path: steps/local-step.md\n    summary: Check the local behavior.\n");
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: Local step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  f.addFile("/worktrees/feature", ".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n");

  const definitions = yield* f.makeDefinitions();
  const registered = yield* definitions.load("project");
  assert.equal(registered.status, "ready");
  const ids = (snapshot: typeof registered) => ({
    steps: snapshot.steps.map(step => [step.origin, step.sourceId ?? null, step.id]),
    workflows: snapshot.workflows.map(workflow => [workflow.origin, workflow.sourceId ?? null, workflow.id]),
    config: [snapshot.config.steps.map(entry => entry.id), snapshot.config.workflows.map(entry => entry.id), snapshot.config.default_workflow],
  });
  const sharedStep = "g60424fae5f1c037d1cf8372a2faf8228a746011ce66e02f7eb14b7c36d20b20";
  const sharedFlow = "g4bcc4e0f49bf3a804bf99099cf7850371e89b867bad6cf08352e84c11ab397a";
  assert.deepEqual(ids(registered), {
    steps: [["global", "shared-step", sharedStep], ["project", "local-step", "local-step"]],
    workflows: [["global", "shared-flow", sharedFlow], ["project", "local-flow", "local-flow"]],
    config: [[sharedStep, "local-step"], [sharedFlow, "local-flow"], sharedFlow],
  });
  assert.equal(registered.revision, "04080d42058370e56e90b2e7652b210ebe9d65d667d9a2e80cf02c77b5189e16");
  assert.equal(registered.globalRevision, "694227d53afde336ccdaa8919020ac2983f61053e2d08a11fdcfe1d74c568f78");
  const worktree = yield* definitions.load("project", "thread");
  assert.equal(worktree.workspaceRoot, "/worktrees/feature");
  assert.equal(worktree.revision, "dab313af83c05dcbfaf429db798b899d52d39c58cd8b0b5361c813d19a8eac21");
  assert.equal(worktree.globalRevision, registered.globalRevision);
  // the revision is a pure function of the read inputs
  assert.equal((yield* definitions.load("project")).revision, registered.revision);
}), {timeout: 10_000});

it.effect("CT-PD-04: aborting create-and-commit setup between the first and second write leaves the first file uncommitted and never commits", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  // the caller's cancel trigger is the definitions' soft cancellation: a cancelled setup settles with its stale outcome
  const cancel = yield* Deferred.make<void>();
  const commits: unknown[] = [];
  const probes: string[][] = [];
  const definitions = yield* definitionsWith(f, {
    writeFile: (root, path, contents) => Effect.gen(function* () {
      f.writes.push({root, path, contents});
      f.addFile(root, path, contents);
      if (f.writes.length === 1) yield* Deferred.succeed(cancel, undefined);
    }),
    commitFiles: (...args) => Effect.sync(() => {commits.push(args);return {status: "committed" as const, commitSha: "never"};}),
    gitProbe: root => Effect.sync((): FreshGitInfo => {
      const changedPaths = f.writes.map(write => write.path);
      probes.push(changedPaths);
      return {workspaceRoot: root, branch: "main", isRepo: true, changedPaths, operationState: {status: "safe"}};
    }),
  });
  const outcome = yield* within(definitions.initialize("project", null, {...setup, action: "create_and_commit"}, cancel), 5_000, "setup");
  assert.deepEqual(outcome, {status: "stale", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "Setup was canceled; files created so far were left uncommitted."});
  assert.deepEqual(f.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  assert.equal(f.trees.get("/workspace")?.has(".t3-supervisor/steps/.gitkeep"), false);
  assert.deepEqual(probes, [[]], "only the first write was checked for commit safety");
  assert.deepEqual(commits, []);
}), {timeout: 10_000});
