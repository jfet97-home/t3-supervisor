import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { ProjectDefinitionLoader, parseDefinitionRules } from "../src/project-definitions.js";
import { ProjectRuleEditor } from "../src/project-rule-editor.js";
import { ProjectFileError, makeProjectWriter, type ProjectFiles, type ProjectWriter } from "../src/project-files.js";
import { WebSocketServer } from "ws";

const original = "# Project policy\nrules:\n  # Keep review\n  - name: Review # label\n    description: Review changes. # explanation\n    required_blocks: [review] # dependencies\n";
const block = "---\nname: Review\ndescription: Review implementation\n---\n## Instructions\nCheck changes.\n## Expected result\nFindings.\n";
function fixture() {
  let root = "/workspace";
  const contents = new Map([[".t3-supervisor/rules.yaml", original], [".t3-supervisor/blocks/review.md", block]]);
  let writes = 0;
  const files: ProjectFiles = {
    directoryExists: async () => true,
    list: async (_root, path) => ({truncated: false, entries: path === ".t3-supervisor" ? [{path: ".t3-supervisor/rules.yaml", kind: "file"}, {path: ".t3-supervisor/blocks", kind: "directory"}] : [{path: ".t3-supervisor/blocks/review.md", kind: "file"}]}),
    read: async (_root, path) => {const value = contents.get(path);if (value === undefined) throw new ProjectFileError("missing");return {contents: value, byteLength: Buffer.byteLength(value), truncated: false};},
  };
  const source = {catalog: () => Effect.succeed({projects: [{project: {id: "project", title: "Project", workspaceRoot: root}, available: true}], threads: []})};
  const t3 = {projection: () => Effect.succeed({snapshotSequence: 1, projection: {thread: {id: "thread", projectId: "project", title: "Work", worktreePath: root, lineage: {parentThreadId: null, relationshipToParent: null}}, messages: [], runs: []}})};
  const loader = new ProjectDefinitionLoader(source, t3, files);
  const writer: ProjectWriter = {checkRulesFile: async () => true, writeRules: async (workspace, value) => {assert.equal(workspace, root);writes++;contents.set(".t3-supervisor/rules.yaml", value);}};
  const editor = new ProjectRuleEditor(loader, writer);
  const input = async () => ({projectId: "project", threadId: null, expectedRevision: (await loader.load("project")).revision!, rules: [{name: "Review", description: "New requirements.", required_blocks: ["review"]}]});
  return {contents, files, loader, writer, editor, input, writes: () => writes, move: (value: string) => {root = value;}};
}

test("edits existing project rules, preserves YAML comments and verifies the result", async () => {
  const f = fixture();const result = await f.editor.save(await f.input());
  assert.equal(result.status, "saved");assert.equal(result.definitions?.rules[0]?.description, "New requirements.");assert.equal(f.writes(), 1);
  const text = f.contents.get(".t3-supervisor/rules.yaml")!;
  for (const comment of ["# Project policy", "# Keep review", "# label", "# explanation", "# dependencies"]) assert.ok(text.includes(comment), comment);
  assert.deepEqual(parseDefinitionRules(text), result.definitions?.rules.map(({name, description, required_blocks}) => ({name, description, required_blocks})));
  assert.equal(result.definitions?.rules[0]?.origin, "project");
});

test("records explicit user saves only after exact successful definition readback", async () => {
  const f = fixture();const authorized: string[] = [];
  const editor = new ProjectRuleEditor(f.loader, f.writer, definitions => authorized.push(definitions.revision!));
  const input = await f.input();
  assert.equal((await editor.save(input)).status, "saved");
  assert.deepEqual(authorized, [(await f.loader.load("project")).revision]);
  assert.equal((await editor.save(input)).status, "conflict");
  assert.equal(authorized.length, 1);
});

test("a failed authorization record reports an uncertain save without repeating the write", async () => {
  const f = fixture();const editor = new ProjectRuleEditor(f.loader, f.writer, () => {throw new Error("storage unavailable");});
  const result = await editor.save(await f.input());
  assert.equal(result.status, "uncertain");assert.equal(f.writes(), 1);
  assert.equal(result.definitions?.rules[0]?.description, "New requirements.");
});

test("adds, renames and removes rules including an explicit empty rules list", async () => {
  const f = fixture();let input = await f.input();input.rules = [{name: "null: yes", description: " - false\nA second line", required_blocks: ["review"]}];
  assert.equal((await f.editor.save(input)).status, "saved");
  input = await f.input();input.rules = [...(await f.loader.load("project")).rules.map(r => ({...r, required_blocks: [...r.required_blocks]})), {name: "Another", description: "Extra review", required_blocks: ["review"]}];
  assert.equal((await f.editor.save(input)).status, "saved");
  input = await f.input();input.rules = [];
  assert.equal((await f.editor.save(input)).status, "saved");assert.deepEqual(parseDefinitionRules(f.contents.get(".t3-supervisor/rules.yaml")!), []);
});

test("rejects stale raw rules, changed block instructions and changed workspace bindings", async () => {
  for (const change of ["rules", "block", "root"]) {
    const f = fixture();const input = await f.input();
    if (change === "rules") f.contents.set(".t3-supervisor/rules.yaml", original + "# Edited outside dashboard\n");
    if (change === "block") f.contents.set(".t3-supervisor/blocks/review.md", block.replace("Check changes.", "New instructions."));
    if (change === "root") f.move("/other-worktree");
    assert.equal((await f.editor.save(input)).status, "conflict");assert.equal(f.writes(), 0);
  }
});

test("validates required blocks, duplicate names, malformed files and target regularity before writing", async () => {
  const f = fixture();let input = await f.input();input.rules[0]!.required_blocks = ["missing"];
  assert.equal((await f.editor.save(input)).status, "invalid");input = await f.input();input.rules.push({...input.rules[0]!});
  assert.equal((await f.editor.save(input)).status, "invalid");input = await f.input();
  f.writer.checkRulesFile = async () => false;assert.equal((await f.editor.save(input)).status, "unavailable");
  f.contents.set(".t3-supervisor/rules.yaml", "rules: [");assert.equal((await f.editor.save(input)).status, "unavailable");assert.equal(f.writes(), 0);
});

test("missing rule files and missing definition folders are never offered for native creation", async () => {
  const f = fixture();f.files.directoryExists = async root => root === "/workspace";
  assert.equal((await f.loader.load("project")).revision, null);assert.equal((await f.editor.save({...(await f.input()), expectedRevision: "a".repeat(64)})).status, "unavailable");
  f.files.directoryExists = async () => true;f.files.list = async () => ({truncated: false, entries: []});
  assert.equal((await f.loader.load("project")).revision, null);assert.equal(f.writes(), 0);
});

test("serializes saves to a workspace and rejects the second stale revision", async () => {
  const f = fixture();const input = await f.input();let release!: () => void;let started!: () => void;
  const paused = new Promise<void>(resolve => {release = resolve;});const began = new Promise<void>(resolve => {started = resolve;});
  const write = f.writer.writeRules;f.writer.writeRules = async (...args) => {started();await paused;return write(...args);};
  const first = f.editor.save(input);await began;const second = f.editor.save(input);release();
  assert.equal((await first).status, "saved");assert.equal((await second).status, "conflict");assert.equal(f.writes(), 1);
});

test("rechecks conversation binding immediately before the native write", async () => {
  const f = fixture();const input = {...await f.input(), threadId: "thread", expectedRevision: (await f.loader.load("project", "thread")).revision!};
  f.writer.checkRulesFile = async () => {f.move("/changed-during-preflight");return true;};
  assert.equal((await f.editor.save(input)).status, "conflict");assert.equal(f.writes(), 0);
});

test("reports permission denial distinctly and never retries an uncertain write or mismatched readback", async () => {
  const f = fixture();const input = await f.input();let attempts = 0;
  f.writer.writeRules = async () => {attempts++;throw new ProjectFileError("permission_required", "write");};
  assert.equal((await f.editor.save(input)).status, "permission_required");assert.equal(attempts, 1);
  f.writer.writeRules = async () => {attempts++;throw new Error("connection closed");};
  assert.equal((await f.editor.save(input)).status, "uncertain");assert.equal(attempts, 2);
  f.writer.writeRules = async () => {attempts++;};
  assert.equal((await f.editor.save(input)).status, "uncertain");assert.equal(attempts, 3);
});

test("native writer checks both regular path components and writes only the fixed rule file", async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();assert.ok(address && typeof address !== "string");let regular = true;const calls: string[] = [];
  server.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(data.toString());calls.push(request.tag);assert.equal(request.payload.cwd, "/workspace");
    const value = request.tag === "projects.writeFile" ? (assert.equal(request.payload.relativePath, ".t3-supervisor/rules.yaml"), {relativePath: ".t3-supervisor/rules.yaml"}) :
      {truncated: false, entries: request.payload.directoryPath === "" ? (regular ? [{path: ".t3-supervisor", kind: "directory"}] : []) : [{path: ".t3-supervisor/rules.yaml", kind: "file"}]};
    socket.send(JSON.stringify({_tag: "Exit", requestId: request.id, exit: {_tag: "Success", value}}));
  }));
  try {
    const writer = makeProjectWriter(`http://127.0.0.1:${address.port}`, "fixture");const signal = AbortSignal.timeout(5000);
    assert.equal(await writer.checkRulesFile("/workspace", signal), true);await writer.writeRules("/workspace", "rules: []\n", signal);
    regular = false;assert.equal(await writer.checkRulesFile("/workspace", signal), false);assert.deepEqual(calls, ["projects.listEntries", "projects.listEntries", "projects.writeFile", "projects.listEntries"]);
  } finally {await new Promise<void>(resolve => server.close(() => resolve()));}
});
