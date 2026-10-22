import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import {Effect} from "effect";
import {WebSocketServer} from "ws";
import {ProjectDefinitions} from "../src/project-definitions.js";
import {ProjectFileError, type GitOperationState} from "../src/project-files.js";
import {asLoaderOptions, asProjectFiles, makeProjectFiles, type ProjectFiles} from "./support/native-files-promise.js";

function fixture(options: {isRepo?: boolean; branch?: string | null; worktree?: string | null; worktreeBranchAfterFirstWrite?: string | null;
  initialChangedPaths?: string[]; unexpectedPathAfterSecondWrite?: string; extraSetupFileAfterSecondWrite?: string;
  cachedVcsPaths?: string[]; collapseSetupStatus?: boolean; staleVcsSnapshot?: boolean; provideGitProbe?: boolean; gitOperationState?: GitOperationState} = {}) {
  let worktreeBranch = options.branch === undefined ? "feature" : options.branch;
  const changedPaths = [...(options.initialChangedPaths ?? [])];
  const freshChangedPaths = [...changedPaths];
  const cachedChangedPaths = [...(options.cachedVcsPaths ?? changedPaths)];
  const trees = new Map<string, Map<string, string>>();
  const directories = new Set(["~", "/workspace", "/worktrees/feature"]);
  const writes: Array<{root: string; path: string; contents: string}> = [];
  const commits: Array<{root: string; paths: readonly string[]; message: string; actionId: string}> = [];
  const freshProbeSnapshots: string[][] = [];
  const vcsSnapshots: string[][] = [];
  const addFile = (root: string, path: string, contents: string) => {
    let tree = trees.get(root);
    if (!tree) {tree = new Map();trees.set(root, tree);}
    tree.set(path, contents);
    directories.add(root);
    directories.add(`${root}/.t3-supervisor`);
    if (path.startsWith(".t3-supervisor/steps/")) directories.add(`${root}/.t3-supervisor/steps`);
    if (path.startsWith(".t3-supervisor/workflows/")) directories.add(`${root}/.t3-supervisor/workflows`);
  };
  const files: ProjectFiles = {
    directoryExists: async path => directories.has(path),
    list: async (root, path) => {
      const tree = trees.get(root) ?? new Map<string, string>();
      if (path === "") return {truncated: false, entries: directories.has(`${root}/.t3-supervisor`) ? [{path: ".t3-supervisor", kind: "directory" as const}] : []};
      if (path === ".t3-supervisor") {
        if (!directories.has(`${root}/.t3-supervisor`)) throw new ProjectFileError("missing");
        const entries: Array<{path: string; kind: "file" | "directory"}> = [];
        if (tree.has(".t3-supervisor/project.yaml")) entries.push({path: ".t3-supervisor/project.yaml", kind: "file"});
        if (directories.has(`${root}/.t3-supervisor/steps`)) entries.push({path: ".t3-supervisor/steps", kind: "directory"});
        if (directories.has(`${root}/.t3-supervisor/workflows`)) entries.push({path: ".t3-supervisor/workflows", kind: "directory"});
        return {truncated: false, entries};
      }
      if (path === ".t3-supervisor/steps" || path === ".t3-supervisor/workflows")
        return {truncated: false, entries: [...tree.keys()].filter(item => item.startsWith(`${path}/`)).map(item => ({path: item, kind: "file" as const}))};
      throw new ProjectFileError("missing");
    },
    read: async (root, path) => {
      const contents = trees.get(root)?.get(path);
      if (contents === undefined) throw new ProjectFileError("missing");
      return {contents, byteLength: Buffer.byteLength(contents), truncated: false};
    },
    vcsInfo: async root => {
      const paths = options.isRepo === false || root === "~" ? [] : options.staleVcsSnapshot ? [...cachedChangedPaths] : [...changedPaths];
      vcsSnapshots.push(paths);
      return {isRepo: options.isRepo ?? root !== "~", branch: root === "/worktrees/feature" ? worktreeBranch : options.branch === undefined ? "main" : options.branch, changedPaths: paths};
    },
    gitOperationState: async () => options.gitOperationState ?? {status: "safe"},
  };
  const source = {catalog: () => Effect.succeed({
    projects: [{project: {id: "project", title: "Project", workspaceRoot: "/workspace"}, available: true}],
    threads: [{id: "main-thread", projectId: "project", title: "Main", lineage: {parentThreadId: null, relationshipToParent: null}}],
  })};
  const t3 = {projection: (threadId: string) => Effect.succeed({snapshotSequence: 1, projection: {
    thread: {id: threadId, projectId: "project", title: "Main", lineage: {parentThreadId: null, relationshipToParent: null}, worktreePath: options.worktree ?? "/worktrees/feature"},
    runs: [], messages: [],
  }})};
  const layer = ProjectDefinitions.layer({source, t3, files: asProjectFiles(files), options: asLoaderOptions({
    globalRoot: "~",
    useGlobalDefinitions: () => false,
    isScratchProject: () => false,
    ...(options.provideGitProbe === false ? {} : {gitProbe: async (targetRoot: string) => {
      const paths = targetRoot === "~" || options.isRepo === false ? [] : [...freshChangedPaths];
      freshProbeSnapshots.push(paths);
      return {
        workspaceRoot: targetRoot,
        branch: targetRoot === "/worktrees/feature" ? worktreeBranch : options.branch === undefined ? "main" : options.branch,
        isRepo: options.isRepo ?? targetRoot !== "~",
        changedPaths: paths,
        operationState: options.gitOperationState ?? {status: "safe" as const},
      };
    }}),
    setupWriter: {
      writeFile: async (root, path, contents) => {
        if (trees.get(root)?.has(path)) throw new ProjectFileError("unavailable", "write");
        writes.push({root, path, contents});
        addFile(root, path, contents);
        if (root !== "~" && options.isRepo !== false) {
          freshChangedPaths.push(path);
          if (options.collapseSetupStatus) {
            if (!changedPaths.includes(".t3-supervisor/")) changedPaths.push(".t3-supervisor/");
          } else changedPaths.push(path);
        }
        if (writes.length === 1 && options.worktreeBranchAfterFirstWrite !== undefined) worktreeBranch = options.worktreeBranchAfterFirstWrite;
        if (writes.length === 2 && options.unexpectedPathAfterSecondWrite) {
          changedPaths.push(options.unexpectedPathAfterSecondWrite);
          freshChangedPaths.push(options.unexpectedPathAfterSecondWrite);
        }
        if (writes.length === 2 && options.extraSetupFileAfterSecondWrite) {
          addFile(root, options.extraSetupFileAfterSecondWrite, "Unexpected setup content.\n");
          freshChangedPaths.push(options.extraSetupFileAfterSecondWrite);
        }
      },
      commitFiles: async (root, paths, message, actionId) => {
        commits.push({root, paths, message, actionId});
        return {status: "committed", commitSha: "commit-123"};
      },
    },
  })});
  return {layer, files, trees, directories, writes, commits, addFile, freshProbeSnapshots, vcsSnapshots};
}

// one definitions operation over the fixture's in-memory checkout, Git probe and setup writer
const withDefinitions = <A, E>(f: ReturnType<typeof fixture>, use: (definitions: ProjectDefinitions["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {return yield* use(yield* ProjectDefinitions);}).pipe(Effect.provide(f.layer));

it.effect("global opt-in initializes a server-home scaffold once and preserves existing contents", () => Effect.gen(function* () {
  const f = fixture();
  const created = yield* withDefinitions(f, definitions => definitions.initializeGlobal(AbortSignal.timeout(5000)));
  assert.equal(created.status, "created");
  assert.equal(created.workspaceRoot, "~");
  assert.equal(created.path, "~/.t3-supervisor");
  assert.equal(f.trees.get("~")?.get(".t3-supervisor/project.yaml"), "workflows: []\nsteps: []\n");
  assert.equal(f.trees.get("~")?.get(".t3-supervisor/steps/.gitkeep"), "");
  assert.equal(f.trees.get("~")?.get(".t3-supervisor/workflows/.gitkeep"), "");
  assert.equal(f.commits.length, 0);
  assert.ok(yield* withDefinitions(f, definitions => definitions.globalFingerprint(AbortSignal.timeout(5000))));

  const existing = "workflows: []\nsteps: []\n";
  f.addFile("~", ".t3-supervisor/project.yaml", existing);
  const before = f.writes.length;
  const unchanged = yield* withDefinitions(f, definitions => definitions.initializeGlobal(AbortSignal.timeout(5000)));
  assert.equal(unchanged.status, "unchanged");
  assert.equal(f.writes.length, before);
  assert.equal(f.trees.get("~")?.get(".t3-supervisor/project.yaml"), existing);
}));

it.effect("project Create writes only the scaffold files and Create plus commit stages only those paths", () => Effect.gen(function* () {
  const createFixture = fixture({isRepo: false, branch: null, worktree: null});
  const created = yield* withDefinitions(createFixture, definitions => definitions.initialize("project", null, {
    origin: "project", action: "create", expectedWorkspaceRoot: "/workspace", expectedBranch: null,
  }, AbortSignal.timeout(5000)));
  assert.equal(created.status, "created");
  assert.deepEqual(createFixture.writes.map(write => [write.path, write.contents]), [
    [".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n"],
    [".t3-supervisor/steps/.gitkeep", ""],
    [".t3-supervisor/workflows/.gitkeep", ""],
  ]);
  assert.equal(createFixture.commits.length, 0);

  const commitFixture = fixture({isRepo: true, branch: "feature"});
  const committed = yield* withDefinitions(commitFixture, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(committed.status, "committed");
  assert.equal(commitFixture.commits.length, 1);
  assert.deepEqual(commitFixture.commits[0]?.paths, [".t3-supervisor/project.yaml", ".t3-supervisor/steps/.gitkeep", ".t3-supervisor/workflows/.gitkeep"]);
  assert.equal(commitFixture.commits[0]?.root, "/worktrees/feature");
}));

it.effect("Create plus commit verifies the exact setup tree when Git collapses untracked paths", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", collapseSetupStatus: true});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "committed");
  assert.equal(f.commits.length, 1);
}));

it.effect("Create plus commit requires a fresh Git probe before writing", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", provideGitProbe: false});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "unavailable");
  assert.match(outcome.message, /fresh local Git status/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.commits.length, 0);
}));

it.effect("Create plus commit uses fresh Git status when the native VCS subscription snapshot stays stale", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", staleVcsSnapshot: true});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "committed");
  assert.equal(f.commits.length, 1);
  assert.ok(f.vcsSnapshots.every(paths => paths.length === 0));
  assert.ok(f.freshProbeSnapshots.some(paths => paths.length === 1 && paths[0] === ".t3-supervisor/project.yaml"));
  assert.ok(f.freshProbeSnapshots.some(paths => paths.length === 2 && paths.includes(".t3-supervisor/project.yaml") && paths.includes(".t3-supervisor/steps/.gitkeep")));
  assert.ok(f.freshProbeSnapshots.some(paths => paths.length === 3 && paths.includes(".t3-supervisor/project.yaml") && paths.includes(".t3-supervisor/steps/.gitkeep") && paths.includes(".t3-supervisor/workflows/.gitkeep")));
}));

it.effect("stale cached foreign paths cannot block setup when fresh Git status is clean", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", staleVcsSnapshot: true, cachedVcsPaths: ["README.md"]});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "committed");
  assert.equal(f.commits.length, 1);
  assert.ok(f.vcsSnapshots.length > 0 && f.vcsSnapshots.every(paths => paths[0] === "README.md"));
  assert.ok(f.freshProbeSnapshots.some(paths => paths.length === 0));
}));

it.effect("setup refuses stale branches, existing folders, and Create plus commit outside Git", () => Effect.gen(function* () {
  const staleFixture = fixture({isRepo: true, branch: "feature"});
  const stale = yield* withDefinitions(staleFixture, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "old-branch",
  }, AbortSignal.timeout(5000)));
  assert.equal(stale.status, "stale");
  assert.equal(staleFixture.writes.length, 0);

  const existingFixture = fixture({isRepo: true, branch: "feature"});
  existingFixture.addFile("/worktrees/feature", ".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n");
  const conflict = yield* withDefinitions(existingFixture, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(conflict.status, "conflict");
  assert.equal(existingFixture.trees.get("/worktrees/feature")?.get(".t3-supervisor/project.yaml"), "workflows: []\nsteps: []\n");
  assert.equal(existingFixture.writes.length, 0);

  const noGitFixture = fixture({isRepo: false, branch: null, worktree: null});
  const unavailable = yield* withDefinitions(noGitFixture, definitions => definitions.initialize("project", null, {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/workspace", expectedBranch: null,
  }, AbortSignal.timeout(5000)));
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.message, /not a Git repository/);
  assert.equal(noGitFixture.writes.length, 0);
}));

it.effect("Create plus commit refuses tracked or staged changes before creating files", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", initialChangedPaths: ["README.md"]});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.message, /clean checkout/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.commits.length, 0);
}));

it.effect("Create plus commit refuses merge or rebase state before creating files", () => Effect.gen(function* () {
  for (const marker of ["MERGE_HEAD", "rebase-merge"]) {
    const f = fixture({isRepo: true, branch: "feature", gitOperationState: {status: "in_progress", marker}});
    const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
      origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
    }, AbortSignal.timeout(5000)));
    assert.equal(outcome.status, "conflict");
    assert.match(outcome.message, new RegExp(marker));
    assert.equal(f.writes.length, 0);
    assert.equal(f.commits.length, 0);
  }
}));

it.effect("Create still leaves the scaffold uncommitted in a dirty or in-progress checkout", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", initialChangedPaths: ["README.md"], provideGitProbe: false,
    gitOperationState: {status: "in_progress", marker: "MERGE_HEAD"}});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "created");
  assert.equal(f.writes.length, 3);
  assert.equal(f.commits.length, 0);
}));

it.effect("Create plus commit stops when any extra change appears with the new setup files", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", unexpectedPathAfterSecondWrite: "README.md"});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.message, /left uncommitted/);
  assert.equal(f.writes.length, 2);
  assert.equal(f.commits.length, 0);
}));

it.effect("Create plus commit rejects extra setup content hidden by Git's collapsed untracked path", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", collapseSetupStatus: true, extraSetupFileAfterSecondWrite: ".t3-supervisor/steps/extra.md"});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create_and_commit", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "conflict");
  assert.match(outcome.message, /other files/);
  assert.equal(f.writes.length, 2);
  assert.equal(f.commits.length, 0);
}));

it.effect("checkout choices expose the registered root and operative main-thread worktree", () => Effect.gen(function* () {
  const f = fixture();
  const targets = yield* withDefinitions(f, definitions => definitions.checkoutTargets("project", AbortSignal.timeout(5000)));
  assert.deepEqual(targets, [
    {origin: "project", threadId: null, workspaceRoot: "/workspace", branch: "main", isGitRepository: true},
    {origin: "project", threadId: "main-thread", workspaceRoot: "/worktrees/feature", branch: "feature", isGitRepository: true},
  ]);
}));

it.live("native Git operation inspection follows a worktree .git pointer with existing T3 read RPCs", () => Effect.gen(function* () {
  // a real loopback socket; the finalizer terminates its clients and closes it
  const server = yield* Effect.acquireRelease(Effect.promise(async () => {
    const listening = new WebSocketServer({host: "127.0.0.1", port: 0});
    await new Promise<void>(resolve => listening.once("listening", resolve));
    return listening;
  }), listening => Effect.promise(() => {
    for (const client of listening.clients) client.terminate();
    return new Promise<void>(resolve => listening.close(() => resolve()));
  }));
  const address = server.address();assert.ok(address && typeof address !== "string");
  const requests: Array<{tag: string; payload: Record<string, unknown>}> = [];
  server.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(data.toString()) as {id: string; tag: string; payload: Record<string, unknown>};
    requests.push({tag: request.tag, payload: request.payload});
    let value: unknown;
    let failure: unknown;
    if (request.tag === "filesystem.getMetadata") {
      const paths = request.payload.paths as string[];
      value = {entries: paths.map(path => path === "/workspace/.git" || path === "/repo/main/.git/worktrees/feature" ? {kind: "directory"} : path === "/worktrees/feature/.git" ? {kind: "file"} : null)};
    } else if (request.tag === "projects.readFile") {
      const cwd = request.payload.cwd as string;
      const path = request.payload.relativePath as string;
      const files = new Map<string, string>([
        ["/workspace|.git/HEAD", "ref: refs/heads/main\n"],
        ["/workspace|.git/MERGE_HEAD", "0123456789abcdef\n"],
        ["/worktrees/feature|.git", "gitdir: /repo/main/.git/worktrees/feature\n"],
        ["/worktrees/feature|/repo/main/.git/worktrees/feature/HEAD", "ref: refs/heads/feature\n"],
      ]);
      const contents = files.get(`${cwd}|${path}`);
      if (contents === undefined) failure = {reasons: [{_tag: "Fail", error: {_tag: "ProjectReadFileError", cause: {code: "ENOENT", message: "ENOENT: no such file or directory"}}}]};
      else value = {relativePath: path, contents, byteLength: Buffer.byteLength(contents), truncated: false};
    } else failure = {reasons: [{_tag: "Fail", error: {message: "Unexpected RPC"}}]};
    socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: failure ? {_tag: "Failure", cause: failure} : {_tag: "Success", value}}));
  }));
  const files = makeProjectFiles(`http://127.0.0.1:${address.port}`, "fixture");
  assert.deepEqual(yield* Effect.promise(async () => files.gitOperationState?.("/workspace", AbortSignal.timeout(5000))), {status: "in_progress", marker: "MERGE_HEAD"});
  assert.deepEqual(yield* Effect.promise(async () => files.gitOperationState?.("/worktrees/feature", AbortSignal.timeout(5000))), {status: "safe"});
  assert.ok(requests.some(request => request.tag === "projects.readFile" && request.payload.relativePath === "/repo/main/.git/worktrees/feature/MERGE_HEAD"));
}));

it.effect("setup rechecks the operative checkout branch before each native file write", () => Effect.gen(function* () {
  const f = fixture({isRepo: true, branch: "feature", worktreeBranchAfterFirstWrite: "other-branch"});
  const outcome = yield* withDefinitions(f, definitions => definitions.initialize("project", "main-thread", {
    origin: "project", action: "create", expectedWorkspaceRoot: "/worktrees/feature", expectedBranch: "feature",
  }, AbortSignal.timeout(5000)));
  assert.equal(outcome.status, "stale");
  assert.equal(f.writes.length, 1);
  assert.equal(f.trees.get("/worktrees/feature")?.get(".t3-supervisor/project.yaml"), "workflows: []\nsteps: []\n");
  assert.equal(f.trees.get("/worktrees/feature")?.has(".t3-supervisor/steps/.gitkeep"), false);
  assert.match(outcome.message, /left uncommitted/);
}));
