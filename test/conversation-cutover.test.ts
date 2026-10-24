import assert from "node:assert/strict";
import {createServer} from "node:http";
import {join} from "node:path";
import {it} from "@effect/vitest";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {cutoverConversations} from "../scripts/cutover-conversation.js";
import {GuidanceDb, guidanceDbLayer} from "../src/db.js";
import {makeT3Client} from "../src/t3.js";
import {deriveConversationEngagement} from "../src/supervision-conversation-contract.js";
import {makeFixture} from "./support/wwc-fixture.js";
import {temporaryDirectory} from "./support/g12-stores.js";

it.live("the one-off cutover rehearses a real SQLite copy, verifies native sources and retains plans and unknown fields", () => Effect.gen(function* () {
  const f = yield* makeFixture();
  const task = (yield* f.supervisors.task(f.mainThreadId))!;
  const {conversation: _conversation, ...legacy} = task;
  assert.ok(_conversation);
  const original = {...legacy, agreementSourceHash: task.sourceHash, agreement: {status: "agreed", message: "Fixture: retain this accepted plan.",
    proposalId: task.workflowProposalId, agreedAt: task.updatedAt - 100, agentMessageId: "fixture-existing-acceptance",
    evidence: {kind: "supervisor_message", messageId: "fixture-existing-proposal"}, workflow: task.workflow},
    retainedNonDisposableField: {pin: "keep-this-identity"}};
  yield* f.db`UPDATE supervisor_task_interpretations SET document=${JSON.stringify(original)} WHERE thread_id=${f.mainThreadId}`;
  const quiet = {...original, id: "quiet-task", threadId: "quiet-main", status: "not_supervised"};
  yield* f.db`INSERT INTO supervisor_task_interpretations VALUES(${'quiet-main'},${f.projectId},${JSON.stringify(quiet)},${task.updatedAt})`;
  const excluded = {...original, id: "excluded-task", threadId: "agent-main"};
  yield* f.db`INSERT INTO supervisor_task_interpretations VALUES(${'agent-main'},${f.projectId},${JSON.stringify(excluded)},${task.updatedAt})`;
  const copy = yield* temporaryDirectory("conversation-cutover-copy-");
  yield* f.db`VACUUM INTO ${join(copy, "guidance.sqlite3")}`;
  const main = f.projections.get(f.mainThreadId)!;
  let reads = 0;
  const quietMain = {...main, thread: {...main.thread, id: "quiet-main"}, runs: main.runs.map(run => ({...run, threadId: "quiet-main"})),
    messages: main.messages.map(message => ({...message, threadId: "quiet-main"})), nodes: Array.isArray(main.nodes) ? main.nodes.map(node => ({...node, threadId: "quiet-main"})) : []};
  const excludedMain = {...quietMain, thread: {...main.thread, id: "agent-main", createdBy: "agent", creationSource: "mcp"},
    runs: main.runs.map(run => ({...run, threadId: "agent-main"})), messages: main.messages.map(message => ({...message, threadId: "agent-main"})),
    nodes: Array.isArray(main.nodes) ? main.nodes.map(node => ({...node, threadId: "agent-main"})) : []};
  const server = yield* Effect.acquireRelease(Effect.sync(() => createServer((request, response) => {
    reads++;response.setHeader("content-type", "application/json");response.end(JSON.stringify({snapshotSequence: 1, projection: request.url?.endsWith("agent-main") ? excludedMain : request.url?.endsWith("quiet-main") ? quietMain : main}));
  })), server => Effect.callback<void>(resume => {server.closeAllConnections();server.close(() => resume(Effect.void));}));
  yield* Effect.callback<void>(resume => {server.listen(0, "127.0.0.1", () => resume(Effect.void));});
  const address = server.address();assert.ok(address && typeof address !== "string");
  const layers = Layer.mergeAll(guidanceDbLayer(copy).pipe(Layer.provide(NodeFileSystem.layer)), makeT3Client({baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture-native-read"}));
  yield* Effect.gen(function* () {
    const sql = yield* GuidanceDb;
    const controls = yield* sql`SELECT * FROM meta ORDER BY key`;
    const before = yield* sql`SELECT thread_id,document,updated_at FROM supervisor_task_interpretations ORDER BY thread_id`;
    assert.deepEqual(yield* cutoverConversations(false), {tasks: 3, converted: 3, applied: false});
    assert.deepEqual(yield* sql`SELECT thread_id,document,updated_at FROM supervisor_task_interpretations ORDER BY thread_id`, before);
    assert.deepEqual(yield* cutoverConversations(true), {tasks: 3, converted: 3, applied: true});
    const rows = yield* sql`SELECT thread_id,document,updated_at FROM supervisor_task_interpretations ORDER BY thread_id`;
    for (const row of rows) {
      const converted = JSON.parse(String(row.document));
      const {conversation, supervision: _assessment, ...rest} = converted;
      assert.equal(_assessment, row.thread_id === "quiet-main" ? "not_needed" : "needed");
      assert.equal(row.updated_at, task.updatedAt);
      if (row.thread_id === f.mainThreadId) {
        assert.deepEqual(rest, original);assert.equal(conversation.authorization.scopeRevision, task.sourceHash);
        assert.equal(conversation.authorization.scopeSources[0].requester, "human");
      } else if (row.thread_id === "quiet-main") {assert.deepEqual(rest, {...quiet, status: "inferred"});assert.equal(conversation.authorization, null);
        assert.equal(deriveConversationEngagement({task: converted, enabled: true, available: true}).availability, "current");}
      else {assert.deepEqual(rest, excluded);assert.equal(conversation.authorization, null);
        assert.equal(deriveConversationEngagement({task: converted, enabled: false, available: true}).availability, "stopped");}
    }
    assert.deepEqual(yield* cutoverConversations(true), {tasks: 3, converted: 0, applied: true});
    assert.deepEqual(yield* sql`SELECT * FROM meta ORDER BY key`, controls);
    yield* sql`UPDATE supervisor_task_interpretations SET document=${JSON.stringify({...quiet, status: "uncertain"})} WHERE thread_id=${"quiet-main"}`;
    assert.equal(yield* Effect.flip(cutoverConversations(true)), "pending_native_effect");
  }).pipe(Effect.provide(layers));
  assert.equal(reads, 6, "quiet and excluded origins are verified without fabricating authorization");
  assert.equal((yield* f.db`SELECT document FROM supervisor_task_interpretations WHERE thread_id=${f.mainThreadId}`)[0]!.document, JSON.stringify(original), "the source database is untouched");
  yield* f.close;
}));
