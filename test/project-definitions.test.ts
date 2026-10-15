import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { WebSocketServer } from "ws";
import { ProjectDefinitionLoader, parseDefinitionBlock, parseDefinitionRules } from "../src/project-definitions.js";
import { makeProjectFiles, ProjectFileError, type ProjectFiles } from "../src/project-files.js";
import { startGuidanceUi } from "../src/guidance-ui.js";
import { forgeDashboardToken } from "../src/service-auth.js";
import type { GuidanceRuntime } from "../src/guidance.js";
import type { SupervisorConfig } from "../src/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rule = "rules:\n  - name: Review\n    description: Behavior changes require review.\n    required_blocks: [review]\n";
const block = "---\nname: Review\ndescription: Examine the implementation.\n---\n\n# Review\n\n## Instructions\nCheck errors and analogous code.\n\n## Expected result\nFindings and their resolutions.\n";
function fixture(options: {root?: string; worktree?: unknown; projectId?: string} = {}) {
  const calls: Array<{root: string; path: string}> = [];
  const content = new Map<string, string>([[".t3-supervisor/rules.yaml", rule], [".t3-supervisor/blocks/review.md", block]]);
  const files: ProjectFiles = {
    directoryExists: async () => true,
    list: async (root, path) => {
      calls.push({root, path});
      return {truncated: false, entries: path === ".t3-supervisor" ? [
        {path: ".t3-supervisor/rules.yaml", kind: "file"}, {path: ".t3-supervisor/blocks", kind: "directory"},
      ] : [...content.keys()].filter(k => k.startsWith(".t3-supervisor/blocks/")).map(path => ({path, kind: "file" as const}))};
    },
    read: async (root, path) => {
      calls.push({root, path});
      const contents = content.get(path);
      if (contents === undefined) throw new ProjectFileError("missing");
      return {contents, byteLength: Buffer.byteLength(contents), truncated: false};
    },
  };
  const loader = new ProjectDefinitionLoader({catalog: () => Effect.succeed({projects: [
    {project: {id: "project", title: "Project", workspaceRoot: options.root ?? "/workspace"}, available: true},
  ], threads: []})}, {projection: () => Effect.succeed({snapshotSequence: 1, projection: {
    thread: {id: "thread", projectId: options.projectId ?? "project", title: "Work", lineage: {parentThreadId: null, relationshipToParent: null}, worktreePath: options.worktree ?? null},
    runs: [], messages: [],
  }})}, files);
  return {loader, files, content, calls};
}

test("loads declarative rules and Markdown blocks without changing their instructions", async () => {
  const f = fixture(); const result = await f.loader.load("project");
  assert.equal(result.status, "ready");
  assert.equal(result.workspaceRoot, "/workspace");
  assert.deepEqual(result.rules[0]?.required_blocks, ["review"]);
  assert.equal(result.blocks[0]?.instructions, "Check errors and analogous code.");
  assert.equal(result.blocks[0]?.expected_result, "Findings and their resolutions.");
  assert.ok(f.calls.every(c => c.path.startsWith(".t3-supervisor")));
});

test("uses the live conversation worktree and rejects cross-project or invalid bindings", async () => {
  const f = fixture({worktree: "/worktrees/feature"});
  assert.equal((await f.loader.load("project", "thread")).status, "ready");
  assert.ok(f.calls.every(c => c.root === "/worktrees/feature"));
  for (const options of [{projectId: "other"}, {worktree: "relative"}, {worktree: 42}]) {
    const invalid = fixture(options);assert.equal((await invalid.loader.load("project", "thread")).status, "unavailable");
    assert.equal(invalid.calls.length, 0);
  }
  const unavailable = fixture();assert.equal((await unavailable.loader.load("unknown")).status, "unavailable");assert.equal(unavailable.calls.length, 0);
});

test("does not fall back to the project root when T3 omits the conversation worktree binding", async () => {
  const f = fixture();
  const loader = new ProjectDefinitionLoader(f.loader.source, {projection: () => Effect.succeed({snapshotSequence: 1, projection: {
    thread: {id: "thread", projectId: "project", title: "Work", lineage: {parentThreadId: null, relationshipToParent: null}}, runs: [], messages: [],
  }})}, f.files);
  assert.equal((await loader.load("project", "thread")).status, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("does not list a missing workspace or treat a missing folder as valid requirements", async () => {
  const f = fixture(); f.files.directoryExists = async () => false;
  assert.equal((await f.loader.load("project")).status, "unavailable");assert.equal(f.calls.length, 0);
  f.files.directoryExists = async root => root === "/workspace";
  assert.equal((await f.loader.load("project")).status, "missing");assert.equal(f.calls.length, 0);
  f.files.directoryExists = async () => true;f.files.list = async () => {throw new ProjectFileError("missing");};
  assert.equal((await f.loader.load("project")).status, "missing");
});

test("reports permission separately from missing or invalid definitions", async () => {
  const f = fixture();f.files.list = async () => {throw new ProjectFileError("permission_required");};
  const s = await f.loader.load("project");assert.equal(s.status, "permission_required");assert.match(s.issues[0]!.message, /filesystem:read/);
});

test("rejects duplicate keys, aliases, unknown fields and unsafe required block references", () => {
  for (const input of [
    "rules: []\nrules: []", "rules: &r []\nother: *r", "rules: []\nextra: true",
    rule.replace("[review]", "[../secret]"), rule.replace("[review]", "[review, review]"),
    rule.replace("[review]", "[]"), rule.replace("name: Review", "when: true"),
    "rules:\n  - &rule {name: Review, description: Required, required_blocks: [review]}\n  - *rule",
  ]) assert.throws(() => parseDefinitionRules(input));
  assert.deepEqual(parseDefinitionRules("rules: []"), []);
  assert.throws(() => parseDefinitionRules(rule + rule.slice("rules:\n".length)), /unique/);
});

test("requires block metadata and both completion-related sections", () => {
  assert.equal(parseDefinitionBlock("review", block.replaceAll("\n", "\r\n")).id, "review");
  for (const input of [block.replace("name: Review", "name: ''"), block.replace("## Expected result", "## Result"), block + "\n## Instructions\nAgain", block.replace("description:", "other:")])
    assert.throws(() => parseDefinitionBlock("review", input));
  assert.throws(() => parseDefinitionBlock("../review", block));
  const fenced = block.replace("Check errors and analogous code.", "Check this example:\n```markdown\n## Expected result\nThis is quoted.\n```");
  assert.match(parseDefinitionBlock("review", fenced).instructions, /This is quoted/);
  assert.equal(parseDefinitionBlock("review", fenced).expected_result, "Findings and their resolutions.");
});

test("flags missing or invalid block references and incomplete listings", async () => {
  const f = fixture();f.content.set(".t3-supervisor/blocks/review.md", "invalid");
  let s = await f.loader.load("project");assert.equal(s.status, "invalid");assert.ok(s.issues.some(i => i.code === "block_reference_missing"));
  f.content.set(".t3-supervisor/blocks/review.md", block);
  const list = f.files.list;f.files.list = async (...args) => ({...await list(...args), truncated: true});
  s = await f.loader.load("project");assert.equal(s.status, "invalid");assert.ok(s.issues.some(i => i.code === "listing_truncated"));
});

test("does not follow unexpected paths advertised in a block listing", async () => {
  const f = fixture();const list = f.files.list;
  f.files.list = async (root, path, signal) => path === ".t3-supervisor" ? list(root, path, signal) : {
    truncated: false, entries: [{path: "/secrets/token.md", kind: "file"}, {path: ".t3-supervisor/blocks/../token.md", kind: "file"}],
  };
  assert.equal((await f.loader.load("project")).status, "invalid");
  assert.ok(!f.calls.some(c => c.path.includes("token")));
});

test("rejects truncated reads and stops when the cumulative byte budget is exhausted", async () => {
  const f = fixture();const read = f.files.read;f.files.read = async (...args) => ({...await read(...args), truncated: true});
  assert.equal((await f.loader.load("project")).status, "invalid");
  f.files.read = read;let reads = 0;
  f.files.list = async (_root, path) => ({truncated: false, entries: path === ".t3-supervisor" ? [{path: ".t3-supervisor/blocks", kind: "directory"}] :
    Array.from({length: 20}, (_, i) => ({path: `.t3-supervisor/blocks/block-${i}.md`, kind: "file"}))});
  f.files.read = async () => {reads++;const contents = "x".repeat(65 * 1024);return {contents, byteLength: contents.length, truncated: false};};
  const s = await f.loader.load("project");assert.equal(s.status, "invalid");assert.ok(reads < 20);assert.deepEqual(s.blocks, []);
});

test("accepts original BOM byte lengths while rejecting other mismatches and invalid files", async () => {
  const f = fixture();const read = f.files.read;
  f.files.read = async (...args) => {const v = await read(...args);return {...v, byteLength: v.byteLength + 3};};
  assert.equal((await f.loader.load("project")).status, "ready");
  assert.equal(parseDefinitionBlock("review", "\uFEFF" + block).id, "review");
  f.files.read = async (...args) => {const v = await read(...args);return {...v, byteLength: v.byteLength + 2};};
  assert.equal((await f.loader.load("project")).status, "invalid");
  for (const code of ["missing", "invalid_file"] as const) {
    f.files.read = async () => {throw new ProjectFileError(code);};
    const result = await f.loader.load("project");assert.equal(result.status, "invalid");
    assert.ok(result.issues.some(i => i.code === (code === "missing" ? "file_missing" : "invalid_file")));
  }
});

test("native transport recognizes serialized file failures whose OS code was removed", async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();assert.ok(address && typeof address !== "string");
  let failure: Record<string, unknown> = {};
  server.on("connection", socket => socket.on("message", data => {
    const r = JSON.parse(data.toString());socket.send(JSON.stringify({_tag: "Exit", requestId: r.id,
      exit: {_tag: "Failure", cause: {reasons: [{_tag: "Fail", error: {_tag: "ProjectReadFileError", ...failure}}]}}}));
  }));
  try {
    const files = makeProjectFiles(`http://127.0.0.1:${address.port}`, "fixture");
    for (const [input, code] of [[{failure: "binary_file"}, "invalid_file"], [{failure: "path_not_file"}, "invalid_file"],
      [{cause: {name: "Error", message: "ENOENT: no such file or directory"}}, "missing"],
      [{cause: {name: "Error", message: "EACCES: permission denied"}}, "invalid_file"]] as const) {
      failure = input;await assert.rejects(files.read("/workspace", ".t3-supervisor/rules.yaml", AbortSignal.timeout(5000)), (e: unknown) => e instanceof ProjectFileError && e.code === code);
    }
  } finally {await new Promise<void>(resolve => server.close(() => resolve()));}
});

test("caller cancellation interrupts an in-progress definition read", async () => {
  const f = fixture();const controller = new AbortController();
  f.files.read = async (_root, _path, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new ProjectFileError("unavailable")), {once: true});
    controller.abort();
  });
  assert.equal((await f.loader.load("project", null, controller.signal)).status, "unavailable");
});

test("native file transport preserves RPC contracts, reports permission and rejects caller path escapes", async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();assert.ok(address && typeof address !== "string");let requests = 0;
  server.on("connection", socket => socket.on("message", data => {
    requests++;const r = JSON.parse(data.toString());
    assert.equal(r.payload.cwd, "/workspace");
    socket.send(JSON.stringify({_tag: "Exit", requestId: r.id, exit: r.tag === "projects.readFile" ? {_tag: "Success", value: {contents: "hello", byteLength: 5, truncated: false}} :
      {_tag: "Failure", cause: {reasons: [{_tag: "Fail", error: {_tag: "EnvironmentAuthorizationError", message: "private details", requiredScope: "filesystem:read"}}]}}}));
  }));
  try {
    const files = makeProjectFiles(`http://127.0.0.1:${address.port}`, "fixture-secret");
    assert.equal((await files.read("/workspace", ".t3-supervisor/rules.yaml", AbortSignal.timeout(5000))).contents, "hello");
    await assert.rejects(files.list("/workspace", ".t3-supervisor", AbortSignal.timeout(5000)), (e: unknown) => e instanceof ProjectFileError && e.code === "permission_required" && !e.message.includes("private"));
    for (const path of ["/secret", ".t3-supervisor/../secret", ".t3-supervisor\\secret", ".t3-supervisor//secret"])
      await assert.rejects(files.read("/workspace", path, AbortSignal.timeout(5000)));
    assert.equal(requests, 2);
  } finally {await new Promise<void>(resolve => server.close(() => resolve()));}
});

test("native transport releases connections when an unanswered request is aborted", async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();assert.ok(address && typeof address !== "string");
  try {
    const files = makeProjectFiles(`http://127.0.0.1:${address.port}`, "fixture");
    await assert.rejects(files.read("/workspace", ".t3-supervisor/rules.yaml", AbortSignal.timeout(30)));
  } finally {for (const client of server.clients) client.terminate();await new Promise<void>(resolve => server.close(() => resolve()));}
});

test("definition endpoint decodes project/thread queries and preserves local API origin checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "definition-api-test-"));
  const f = fixture({worktree: "/worktrees/feature"});
  const config: SupervisorConfig = {dataDirectory: directory, t3Url: "unused", t3TokenFile: "unused", mcpxUrl: "unused", cxCommand: "unused",
    cxHome: directory, cxSeedFile: "unused", excludedThreadIds: [], healthPort: 0, modelTimeoutMs: 1000, uiPort: 0, uiHost: "127.0.0.1", uiAssetsDirectory: directory};
  // the definition route uses its own loader and does not consult guidance runtime
  const ui = await startGuidanceUi(config, {} as GuidanceRuntime, f.loader);
  try {
    const address = ui.server.address();assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const grant = await forgeDashboardToken(directory);
    const login = await fetch(origin + "/auth/login", {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify({token: grant.token})});
    assert.equal(login.status, 200);
    const headers = {"x-supervisor-session": (await login.json()).session as string};
    const response = await fetch(origin + "/api/guidance/project-definitions?projectId=project&threadId=thread", {headers});
    assert.equal(response.status, 200);const value = await response.json();assert.equal(value.status, "ready");assert.equal(value.workspaceRoot, "/worktrees/feature");
    assert.equal((await fetch(origin + "/api/guidance/project-definitions", {headers})).status, 400);
    assert.equal((await fetch(origin + "/api/guidance/project-definitions?projectId=project", {headers: {...headers, Origin: "https://foreign.invalid"}})).status, 403);
    f.files.directoryExists = async () => {throw new ProjectFileError("permission_required");};
    const denied = await fetch(origin + "/api/guidance/project-definitions?projectId=project", {headers});
    assert.equal(denied.status, 200);assert.equal((await denied.json()).status, "permission_required");
    f.files.directoryExists = async () => true;
    let began!: () => void;let stopped!: () => void;
    const reading = new Promise<void>(resolve => {began = resolve;});
    const cancelled = new Promise<void>(resolve => {stopped = resolve;});
    f.files.read = async (_root, _path, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {stopped();reject(new ProjectFileError("unavailable"));}, {once: true});
      began();
    });
    const controller = new AbortController();
    const request = fetch(origin + "/api/guidance/project-definitions?projectId=project", {headers, signal: controller.signal});
    await reading;controller.abort();await assert.rejects(request);
    await Promise.race([cancelled, new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error("HTTP cancellation did not reach file read")), 1000);cancelled.then(() => clearTimeout(timer));})]);
  } finally {await ui.close();await rm(directory, {recursive: true, force: true});}
});
