import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {Effect} from "effect";
import {ProjectDefinitionLoader} from "../src/project-definitions.js";
import {ProjectFileError, type ProjectFiles} from "../src/project-files.js";

const blockFile = (name: string) => `---\nname: ${name}\ndescription: Shared instructions.\n---\n\n## Instructions\nCheck the relevant behavior.\n\n## Expected result\nThe required behavior is verified.\n`;
const ruleFile = (name: string, id: string, description = "Apply the check.") => `rules:\n  - name: ${name}\n    description: ${description}\n    required_blocks: [${id}]\n`;

function fixture(options: {projectId?: string; root?: string; scratch?: boolean; globalEnabled?: () => boolean; wideHome?: boolean} = {}) {
  const projectId = options.projectId ?? "project";
  const root = options.root ?? "/workspace";
  const trees = new Map<string, Map<string, string>>();
  const directories = new Set(["~", root, "/workspace", "/worktrees/feature", "/worker/worktree"]);
  const calls: Array<{kind: string; root: string; path: string}> = [];
  const failures = new Map<string, ProjectFileError>();
  const threads = [
    {id: "main-thread", projectId, title: "Implementation", lineage: {parentThreadId: null, relationshipToParent: null}},
    {id: "worker-thread", projectId, title: "Worker", lineage: {parentThreadId: "main-thread", relationshipToParent: "child"}},
  ];
  const addFile = (targetRoot: string, path: string, contents: string) => {
    let tree = trees.get(targetRoot);
    if (!tree) {tree = new Map();trees.set(targetRoot, tree);}
    tree.set(path, contents);
    directories.add(targetRoot);
    directories.add(`${targetRoot}/.t3-supervisor`);
    if (path.startsWith(".t3-supervisor/blocks/")) directories.add(`${targetRoot}/.t3-supervisor/blocks`);
  };
  const hasFolder = (targetRoot: string) => directories.has(`${targetRoot}/.t3-supervisor`);
  const files: ProjectFiles = {
    directoryExists: async path => directories.has(path) || [...trees.keys()].some(targetRoot => path === `${targetRoot}/.t3-supervisor` || path === `${targetRoot}/.t3-supervisor/blocks` && directories.has(path)),
    list: async (targetRoot, path) => {
      calls.push({kind: "list", root: targetRoot, path});
      const failure = failures.get(`${targetRoot}|${path}`);
      if (failure) throw failure;
      const tree = trees.get(targetRoot) ?? new Map<string, string>();
      if (path === "") return options.wideHome && targetRoot === "~"
        ? {truncated: true, entries: Array.from({length: 513}, (_, index) => ({path: `home-entry-${index}`, kind: "directory" as const}))}
        : {truncated: false, entries: hasFolder(targetRoot) ? [{path: ".t3-supervisor", kind: "directory" as const}] : []};
      if (path === ".t3-supervisor") {
        if (!hasFolder(targetRoot)) throw new ProjectFileError("missing");
        const entries: Array<{path: string; kind: "file" | "directory"}> = [];
        if (tree.has(".t3-supervisor/rules.yaml")) entries.push({path: ".t3-supervisor/rules.yaml", kind: "file"});
        if (directories.has(`${targetRoot}/.t3-supervisor/blocks`)) entries.push({path: ".t3-supervisor/blocks", kind: "directory"});
        return {truncated: false, entries};
      }
      if (path === ".t3-supervisor/blocks") return {truncated: false, entries: [...tree.keys()].filter(item => item.startsWith(`${path}/`)).map(item => ({path: item, kind: "file" as const}))};
      throw new ProjectFileError("missing");
    },
    read: async (targetRoot, path) => {
      calls.push({kind: "read", root: targetRoot, path});
      const contents = trees.get(targetRoot)?.get(path);
      if (contents === undefined) throw new ProjectFileError("missing");
      return {contents, byteLength: Buffer.byteLength(contents), truncated: false};
    },
    vcsInfo: async targetRoot => ({isRepo: targetRoot !== "~", branch: targetRoot === "/worktrees/feature" ? "feature" : "main", changedPaths: []}),
  };
  const source = {catalog: () => Effect.succeed({
    projects: [{project: {id: projectId, title: "Project", workspaceRoot: root}, available: true}],
    threads,
  })};
  const t3 = {projection: (threadId: string) => Effect.succeed({snapshotSequence: 1, projection: {
    thread: {id: threadId, projectId, title: threadId, lineage: {parentThreadId: threadId === "worker-thread" ? "main-thread" : null, relationshipToParent: null},
      worktreePath: threadId === "main-thread" ? "/worktrees/feature" : "/worker/worktree"}, runs: [], messages: [],
  }})};
  const loader = new ProjectDefinitionLoader(source, t3, files, {
    globalRoot: "~",
    useGlobalDefinitions: options.globalEnabled ?? (() => true),
    isScratchProject: (_id, registeredRoot) => options.scratch === true && registeredRoot === root,
    setupWriter: {
      writeFile: async (targetRoot, path, contents) => {
        if (trees.get(targetRoot)?.has(path)) throw new ProjectFileError("unavailable", "write");
        addFile(targetRoot, path, contents);
      },
      commitFiles: async (_targetRoot, paths) => {
        assert.deepEqual(paths, [".t3-supervisor/rules.yaml", ".t3-supervisor/blocks/.gitkeep"]);
        return {status: "committed", commitSha: "abc123"};
      },
    },
  });
  return {loader, files, trees, directories, calls, failures, threads, addFile};
}

test("merges global and operative-checkout definitions with collision-free IDs and provenance", async () => {
  const f = fixture();
  const globalRule = ruleFile("Review", "review");
  const globalBlockId = `g${createHash("sha256").update("global-block\u0000review\u00000").digest("hex").slice(0, 63)}`;
  f.addFile("~", ".t3-supervisor/rules.yaml", globalRule);
  f.addFile("~", ".t3-supervisor/blocks/review.md", blockFile("Review"));
  f.addFile("/workspace", ".t3-supervisor/rules.yaml", ruleFile("Review", globalBlockId, "Keep project block IDs intact."));
  f.addFile("/workspace", `.t3-supervisor/blocks/${globalBlockId}.md`, blockFile("Project review"));
  const supplied: string[] = [];
  const snapshot = await f.loader.load("project", null, undefined, contents => supplied.push(contents));
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.workspaceRoot, "/workspace");
  assert.equal(snapshot.rules.length, 2);
  const globalRuleSnapshot = snapshot.rules.find(rule => rule.origin === "global");
  const projectRuleSnapshot = snapshot.rules.find(rule => rule.origin === "project");
  assert.ok(globalRuleSnapshot);
  assert.ok(projectRuleSnapshot);
  assert.match(globalRuleSnapshot.name, /^Global: Review \[global /);
  assert.equal(projectRuleSnapshot.name, "Review");
  assert.notEqual(globalRuleSnapshot.required_blocks[0], globalBlockId);
  assert.equal(projectRuleSnapshot.required_blocks[0], globalBlockId);
  const globalBlock = snapshot.blocks.find(block => block.origin === "global");
  const projectBlock = snapshot.blocks.find(block => block.origin === "project");
  assert.ok(globalBlock);
  assert.ok(projectBlock);
  assert.match(globalBlock.id, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  assert.notEqual(globalBlock.id, globalBlockId);
  assert.equal(globalBlock.sourceId, "review");
  assert.equal(globalBlock.path, "~/.t3-supervisor/blocks/review.md");
  assert.equal(projectBlock.id, globalBlockId);
  assert.equal(projectBlock.path, ".t3-supervisor/blocks/" + globalBlockId + ".md");
  assert.deepEqual(supplied, [ruleFile("Review", globalBlockId, "Keep project block IDs intact.")]);
  assert.equal(snapshot.globalRevision, await f.loader.globalFingerprint(AbortSignal.timeout(5000)));
});

test("keeps a missing optional global folder in the revision while local rules remain ready", async () => {
  const f = fixture();
  f.addFile("/workspace", ".t3-supervisor/rules.yaml", "rules: []\n");
  const snapshot = await f.loader.load("project");
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.rules, []);
  assert.ok(snapshot.revision);
  assert.ok(snapshot.globalRevision);
  assert.equal(snapshot.globalRevision, await f.loader.globalFingerprint(AbortSignal.timeout(5000)));
});

test("global setup checks only the narrow folder when the server home has over 512 children", async () => {
  const f = fixture({wideHome: true});
  const outcome = await f.loader.initializeGlobal(AbortSignal.timeout(5000));
  assert.equal(outcome.status, "created");
  assert.ok(f.calls.some(call => call.root === "~" && call.path === ".t3-supervisor"));
  assert.ok(f.calls.every(call => call.root !== "~" || call.path !== ""));
  assert.equal(f.trees.get("~")?.get(".t3-supervisor/rules.yaml"), "rules: []\n");
});

test("project presence stays independent from an existing global definitions folder", async () => {
  const f = fixture();
  f.addFile("~", ".t3-supervisor/rules.yaml", "rules: []\n");
  assert.deepEqual(await f.loader.presence("project", AbortSignal.timeout(5000)), {status: "missing"});
});

test("uses global definitions alone for Scratch and keeps an explicit disabled snapshot revisioned", async () => {
  let enabled = true;
  const f = fixture({projectId: "scratch", root: "/scratch", scratch: true, globalEnabled: () => enabled});
  f.addFile("~", ".t3-supervisor/rules.yaml", ruleFile("Shared", "shared"));
  f.addFile("~", ".t3-supervisor/blocks/shared.md", blockFile("Shared"));
  f.addFile("/scratch", ".t3-supervisor/rules.yaml", ruleFile("Local should not load", "local"));
  f.addFile("/scratch", ".t3-supervisor/blocks/local.md", blockFile("Local"));
  const active = await f.loader.load("scratch", "main-thread");
  assert.equal(active.status, "ready");
  assert.equal(active.projectId, "scratch");
  assert.equal(active.workspaceRoot, "/worktrees/feature");
  assert.equal(active.globalOnly, true);
  assert.deepEqual(active.rules.map(rule => rule.name), ["Shared"]);
  assert.ok(f.calls.every(call => call.root !== "/worktrees/feature" || !call.path.includes(".t3-supervisor")));
  const activeRevision = active.revision;
  enabled = false;
  const disabled = await f.loader.load("scratch", "main-thread");
  assert.equal(disabled.status, "ready");
  assert.deepEqual(disabled.rules, []);
  assert.deepEqual(disabled.blocks, []);
  assert.equal(disabled.globalOnly, true);
  assert.equal(disabled.globalRevision, null);
  assert.notEqual(disabled.revision, activeRevision);
  assert.ok(f.calls.every(call => call.root !== "/worktrees/feature" || !call.path.includes(".t3-supervisor")));
});

test("an unreadable enabled global scope never becomes an empty valid rules collection", async () => {
  const f = fixture();
  f.addFile("/workspace", ".t3-supervisor/rules.yaml", "rules: []\n");
  f.failures.set("~|.t3-supervisor", new ProjectFileError("permission_required"));
  const snapshot = await f.loader.load("project");
  assert.equal(snapshot.status, "permission_required");
  assert.deepEqual(snapshot.rules, []);
  assert.equal(snapshot.revision, null);
  assert.equal(snapshot.globalRevision, null);
});

test("global definition fingerprints and workflow revisions follow active global input changes", async () => {
  let enabled = true;
  const f = fixture({globalEnabled: () => enabled});
  f.addFile("~", ".t3-supervisor/rules.yaml", ruleFile("Shared", "shared", "First description."));
  f.addFile("~", ".t3-supervisor/blocks/shared.md", blockFile("Shared"));
  f.addFile("/workspace", ".t3-supervisor/rules.yaml", "rules: []\n");
  const first = await f.loader.load("project");
  const firstFingerprint = await f.loader.globalFingerprint(AbortSignal.timeout(5000));
  assert.equal(first.globalRevision, firstFingerprint);
  f.addFile("~", ".t3-supervisor/rules.yaml", ruleFile("Shared", "shared", "Changed description."));
  const second = await f.loader.load("project");
  assert.notEqual(second.globalRevision, first.globalRevision);
  assert.notEqual(second.revision, first.revision);
  enabled = false;
  const disabled = await f.loader.load("project");
  assert.equal(disabled.status, "ready");
  assert.deepEqual(disabled.rules, []);
  assert.equal(disabled.globalRevision, null);
  assert.notEqual(disabled.revision, second.revision);
});

test("keeps the complete merged collection visible when global and project rules exceed the shared limit", async () => {
  const f = fixture();
  const definitions = (prefix: string, count: number) => `rules:\n${Array.from({length: count}, (_, index) =>
    `  - name: ${prefix}-${index}\n    description: Review behavior.\n    required_blocks: [shared]\n`).join("")}`;
  f.addFile("~", ".t3-supervisor/rules.yaml", definitions("global", 51));
  f.addFile("/workspace", ".t3-supervisor/rules.yaml", definitions("project", 50));
  const snapshot = await f.loader.load("project");
  assert.equal(snapshot.status, "invalid");
  assert.equal(snapshot.rules.length, 101);
  assert.ok(snapshot.issues.some(issue => issue.code === "combined_rule_limit"));
});

test("does not count the empty-folder marker as a workflow block", async () => {
  const f = fixture();
  f.addFile("/workspace", ".t3-supervisor/rules.yaml", "rules: []\n");
  f.addFile("/workspace", ".t3-supervisor/blocks/.gitkeep", "");
  for (let index = 0; index < 100; index++) {
    const id = `block-${index}`;
    f.addFile("/workspace", `.t3-supervisor/blocks/${id}.md`, blockFile(id));
  }
  const snapshot = await f.loader.load("project");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.blocks.length, 100);
});
