import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Clock, Config, Console, Effect, FileSystem, Layer, Schema } from "effect";
import { GuidanceDb, guidanceDbLayer } from "../src/db.js";
import { makeT3Client, T3Client } from "../src/t3.js";
import { ConversationFacts, emptyConversation } from "../src/supervision-conversation-contract.js";
import { requesterSources } from "../src/supervision-conversation.js";
import {conversationOriginAllowed} from "../src/task-requester.js";

// one operational cutover, with Supervisor stopped. It reads T3, changes only task JSON and retains all other bytes/IDs.
// rehearse on a SQLite backup first. Fresh databases need no cutover. Unknown native effects block the whole transaction.
// T3_URL/T3_TOKEN_FILE are the existing read endpoint/credential. No token or native message content is printed.
// node --import tsx scripts/cutover-conversation.ts <data-directory> [--apply]
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const Task = Schema.Struct({id: Schema.String, sourceHash: Schema.String, sourceMessageId: Schema.String, sourceRunId: Schema.String,
  sourceOrdinal: Schema.Int, status: Schema.String, objective: Schema.NullOr(Schema.String)});
const Row = Schema.Struct({thread_id: Schema.String, project_id: Schema.String, document: Schema.fromJsonString(ObjectValue)});
const Setting = Schema.Struct({agentCreatedThreadsEnabledAt: Schema.optionalKey(Schema.NullOr(Schema.Number))});

export const cutoverConversations = (apply: boolean) => Effect.gen(function* () {
  const sql = yield* GuidanceDb;
  const native = yield* T3Client;
  const at = yield* Clock.currentTimeMillis;
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(yield* sql`SELECT thread_id,project_id,document FROM supervisor_task_interpretations`);
  const ownedRows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({id: Schema.String})))(yield* sql`SELECT id FROM supervisor_owned_threads`);
  const owned = new Set(ownedRows.map(row => row.id));
  const settings = new Map<string, number | null>();
  const changes: Array<{threadId: string; document: string}> = [];
  for (const row of rows) {
    if (row.document.conversation !== undefined) {
      yield* Schema.decodeUnknownEffect(ConversationFacts)(row.document.conversation);continue;
    }
    const task = yield* Schema.decodeUnknownEffect(Task)(row.document);
    if (["queued", "dispatching", "waiting", "uncertain"].includes(task.status)) return yield* Effect.fail("pending_native_effect");
    if (!settings.has(row.project_id)) {
      const [stored] = yield* sql`SELECT document FROM supervisor_project_settings WHERE project_id=${row.project_id}`;
      const value = stored ? yield* Schema.decodeUnknownEffect(Schema.Struct({document: Schema.fromJsonString(Setting)}))(stored) : null;
      settings.set(row.project_id, value?.document.agentCreatedThreadsEnabledAt ?? null);
    }
    const main = yield* native.projection(row.thread_id).pipe(Effect.option);
    const sources = main._tag === "Some" && main.value.projection.thread.projectId === row.project_id
      ? requesterSources(main.value.projection, {owned, agentRequestsAfter: settings.get(row.project_id) ?? null}) : [];
    const source = sources.find(source => source.messageId === task.sourceMessageId && source.runId === task.sourceRunId && source.ordinal === task.sourceOrdinal && source.hash === task.sourceHash);
    const originExcluded = main._tag === "Some" && main.value.projection.thread.projectId === row.project_id &&
      !conversationOriginAllowed(main.value.projection.thread, {owned, agentRequestsAfter: settings.get(row.project_id) ?? null});
    if (task.status === "inferred" && task.objective && !source && !originExcluded) return yield* Effect.fail("source_not_verified");
    const facts = {...emptyConversation(at), draft: {...emptyConversation(at).draft, objective: task.objective}, considered: source ?? null, observed: sources.at(-1) ?? null,
      authorization: task.status === "inferred" && task.objective && source ? {scopeRevision: task.sourceHash, outcome: task.objective, limits: [], scopeSources: [source],
        state: "authorized" as const, stateSource: source, attemptId: "conversation-cutover"} : null};
    yield* Schema.decodeUnknownEffect(ConversationFacts)(facts);
    changes.push({threadId: row.thread_id, document: JSON.stringify({...row.document, conversation: facts,
      supervision: task.status === "not_supervised" ? "not_needed" : "needed", status: task.status === "not_supervised" ? "inferred" : task.status})});
  }
  if (apply) yield* sql.withTransaction(Effect.forEach(changes, row =>
    sql`UPDATE supervisor_task_interpretations SET document=${row.document} WHERE thread_id=${row.threadId}`, {discard: true}));
  return {tasks: rows.length, converted: changes.length, applied: apply};
});

const program = Effect.gen(function* () {
  const directory = process.argv[2];
  if (!directory?.startsWith("/") || process.argv.length > 4 || process.argv[3] !== undefined && process.argv[3] !== "--apply")
    return yield* Effect.fail("usage");
  const files = yield* FileSystem.FileSystem;
  const tokenFile = yield* Config.String("T3_TOKEN_FILE");
  const token = yield* files.readFileString(tokenFile);
  const baseUrl = yield* Config.String("T3_URL").pipe(Config.withDefault("http://127.0.0.1:3773"));
  const result = yield* cutoverConversations(process.argv[3] === "--apply").pipe(Effect.provide(Layer.mergeAll(guidanceDbLayer(directory), makeT3Client({baseUrl, token: token.trim()}))));
  yield* Console.log(JSON.stringify(result));
});
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer), Effect.catchCause(() =>
  Effect.andThen(Console.error("Conversation cutover did not apply: verify arguments, native read access, settled effects and stored sources."), Effect.sync(() => {process.exitCode = 1;})))),
{disableErrorReporting: true});
