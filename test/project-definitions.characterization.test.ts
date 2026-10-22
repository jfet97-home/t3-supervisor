import assert from "node:assert/strict";
import { it } from "vitest";
import { ProjectDefinitionLoader } from "../src/project-definitions.js";
import { ProjectFileError, type FreshGitInfo, type ProjectFiles } from "../src/project-files.js";
import { deferred, loopTurn, within } from "./support/c3b-http.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

const setup = {origin: "project", action: "create", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"} as const;

// the fixture's in-memory files with a loader whose setup writer and options the test controls
const loaderWith = (f: ReturnType<typeof makeDefinitionFixture>, options: {
  files?: ProjectFiles;
  writeFile?: (root: string, path: string, contents: string, signal: AbortSignal) => Promise<void>;
  commitFiles?: (root: string, paths: readonly string[], message: string, actionId: string, signal: AbortSignal) => Promise<{status: "committed" | "uncertain"; commitSha?: string}>;
  gitProbe?: (root: string, signal: AbortSignal) => Promise<FreshGitInfo>;
} = {}) => {
  return new ProjectDefinitionLoader(f.loader.source, f.loader.t3, options.files ?? f.files, {
    globalRoot: f.globalRoot,
    useGlobalDefinitions: () => false,
    isScratchProject: () => false,
    setupWriter: {
      writeFile: options.writeFile ?? (async (root, path, contents) => {f.writes.push({root, path, contents});f.addFile(root, path, contents);}),
      ...(options.commitFiles ? {commitFiles: options.commitFiles} : {}),
    },
    ...(options.gitProbe ? {gitProbe: options.gitProbe} : {}),
  });
};

it("CT-PD-01: two concurrent initialize() calls for one checkout write the three scaffold files once; the second reports the existing folder", {timeout: 10_000}, async () => {
  const f = makeDefinitionFixture({threadRoot: null});
  const events: string[] = [];
  const loader = loaderWith(f, {writeFile: async (root, path, contents) => {
    events.push(`write:${path}`);
    await loopTurn();
    f.writes.push({root, path, contents});
    f.addFile(root, path, contents);
  }});
  const [first, second] = await within(Promise.all([
    loader.initialize("project", null, setup, AbortSignal.timeout(5_000)),
    loader.initialize("project", null, setup, AbortSignal.timeout(5_000)),
  ]), 5_000, "both setups");
  assert.deepEqual(first, {status: "created", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "Created project.yaml, steps/.gitkeep and workflows/.gitkeep; all files are uncommitted."});
  assert.deepEqual(second, {status: "conflict", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "The selected checkout already has a .t3-supervisor folder; no files were changed."});
  assert.deepEqual(events, ["write:.t3-supervisor/project.yaml", "write:.t3-supervisor/steps/.gitkeep", "write:.t3-supervisor/workflows/.gitkeep"]);
  assert.deepEqual(f.writes.map(write => [write.path, write.contents]), [
    [".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n"], [".t3-supervisor/steps/.gitkeep", ""], [".t3-supervisor/workflows/.gitkeep", ""],
  ]);
});

// a native read that hangs until its signal aborts and then fails as the native transport does
const hangingRead = (f: ReturnType<typeof makeDefinitionFixture>, hungPath: string) => {
  const entered = deferred<AbortSignal>();
  const files: ProjectFiles = {...f.files, read: (root, path, signal) => {
    if (path !== hungPath) return f.files.read(root, path, signal);
    entered.resolve(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new ProjectFileError("unavailable")), {once: true}));
  }};
  return {files, entered: entered.promise};
};

const seed = (f: ReturnType<typeof makeDefinitionFixture>) => {
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows: []\nsteps:\n  - path: steps/check.md\n    summary: Check the change.\n");
  f.addFile(f.root, ".t3-supervisor/steps/check.md", "---\nid: check\nname: check\ndescription: Inspect the changed behavior.\n---\n");
  f.addDirectory(f.root, ".t3-supervisor/workflows");
};

const unavailableSnapshot = {status: "unavailable", complete: false, revision: null,
  issues: [{path: ".t3-supervisor/steps/check.md", code: "definition_source_unreadable", message: "T3 project file access is unavailable."}]};
const summary = (snapshot: Awaited<ReturnType<ProjectDefinitionLoader["load"]>>) =>
  ({status: snapshot.status, complete: snapshot.complete, revision: snapshot.revision, issues: snapshot.issues});

it("CT-PD-02: a hung native read ends when the caller aborts, giving an incomplete unavailable snapshot without a revision", {timeout: 10_000}, async () => {
  const f = makeDefinitionFixture({threadRoot: null});
  seed(f);
  assert.equal((await f.loader.load("project")).complete, true);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const loader = loaderWith(f, {files});
  const cancel = new AbortController();
  const pending = loader.load("project", null, cancel.signal);
  const signal = await within(entered, 5_000, "hung read");
  assert.equal(signal.aborted, false);
  cancel.abort();
  assert.deepEqual(summary(await within(pending, 5_000, "aborted load")), unavailableSnapshot);
});

it("CT-PD-02: without a caller signal the hard-coded 30 s load deadline ends a hung read with the same unavailable snapshot", {timeout: 60_000}, async () => {
  const f = makeDefinitionFixture({threadRoot: null});
  seed(f);
  const {files, entered} = hangingRead(f, ".t3-supervisor/steps/check.md");
  const loader = loaderWith(f, {files});
  const started = performance.now();
  const pending = loader.load("project");
  await within(entered, 5_000, "hung read");
  const snapshot = await within(pending, 45_000, "load deadline");
  const elapsed = performance.now() - started;
  assert.deepEqual(summary(snapshot), unavailableSnapshot);
  assert.ok(elapsed >= 29_900 && elapsed < 40_000, `deadline after ${Math.round(elapsed)} ms`);
});

it("CT-PD-03: a fixture tree yields the golden revision, global revision and namespaced global IDs", {timeout: 10_000}, async () => {
  const f = makeDefinitionFixture({globalEnabled: true});
  f.addFile(f.globalRoot, ".t3-supervisor/project.yaml",
    "workflows:\n  - path: workflows/shared-flow.yaml\n    summary: Run the shared flow.\nsteps:\n  - path: steps/shared-step.md\n    summary: Run the shared step.\n    required: true\ndefault_workflow: shared-flow\n");
  f.addFile(f.globalRoot, ".t3-supervisor/steps/shared-step.md", "---\nid: shared-step\nname: Shared step\ndescription: Check shared behavior.\n---\n");
  f.addFile(f.globalRoot, ".t3-supervisor/workflows/shared-flow.yaml", "name: Shared flow\ndescription: Shared flow workflow.\nsequence:\n  - step: shared-step\n");
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows:\n  - path: workflows/local-flow.yaml\n    summary: Run the local flow.\nsteps:\n  - path: steps/local-step.md\n    summary: Check the local behavior.\n");
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: Local step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  f.addFile("/worktrees/feature", ".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n");

  const registered = await f.loader.load("project");
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
  const worktree = await f.loader.load("project", "thread");
  assert.equal(worktree.workspaceRoot, "/worktrees/feature");
  assert.equal(worktree.revision, "dab313af83c05dcbfaf429db798b899d52d39c58cd8b0b5361c813d19a8eac21");
  assert.equal(worktree.globalRevision, registered.globalRevision);
  // the revision is a pure function of the read inputs
  assert.equal((await f.loader.load("project")).revision, registered.revision);
});

it("CT-PD-04: aborting create-and-commit setup between the first and second write leaves the first file uncommitted and never commits", {timeout: 10_000}, async () => {
  const f = makeDefinitionFixture({threadRoot: null});
  const cancel = new AbortController();
  const commits: unknown[] = [];
  const probes: string[][] = [];
  const loader = loaderWith(f, {
    writeFile: async (root, path, contents) => {
      f.writes.push({root, path, contents});
      f.addFile(root, path, contents);
      if (f.writes.length === 1) cancel.abort();
    },
    commitFiles: async (...args) => {commits.push(args);return {status: "committed", commitSha: "never"};},
    gitProbe: async root => {
      const changedPaths = f.writes.map(write => write.path);
      probes.push(changedPaths);
      return {workspaceRoot: root, branch: "main", isRepo: true, changedPaths, operationState: {status: "safe"}};
    },
  });
  const outcome = await within(loader.initialize("project", null, {...setup, action: "create_and_commit"}, cancel.signal), 5_000, "setup");
  assert.deepEqual(outcome, {status: "stale", workspaceRoot: "/workspace", branch: "main", path: ".t3-supervisor",
    message: "Setup was canceled; files created so far were left uncommitted."});
  assert.deepEqual(f.writes.map(write => write.path), [".t3-supervisor/project.yaml"]);
  assert.equal(f.trees.get("/workspace")?.has(".t3-supervisor/steps/.gitkeep"), false);
  assert.deepEqual(probes, [[]], "only the first write was checked for commit safety");
  assert.deepEqual(commits, []);
});
