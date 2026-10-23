import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Scheduler } from "effect";
import { GuidanceDb } from "../src/db.js";
import { GuidanceStoreError } from "../src/guidance-sql.js";
import {
  type ConversationRequest,
  RequestInflight,
  SupervisorConversationStore,
  type SupervisorConversationStoreShape,
  type WorkflowAgreementCandidate,
  type WorkflowIntroduction,
} from "../src/supervisor-conversation-store.js";
import { guidanceDb, rows, sequentialIds, temporaryDirectory } from "./support/guidance-store-services.js";

// target regressions of the SupervisorConversationStore effect service on a temporary guidance.sqlite3 through the
// production layers: CT-CSTORE-01..04 at service level, the CC-GDB-IMPLICIT read-modify-writes in one transaction under
// forced fiber yields, stored documents decoded without changing their bytes, and typed row failures

const projectId = "project-a";
const baseTime = Date.parse("2026-10-13T10:00:00.000Z");

const layer = (directory: string) =>
  SupervisorConversationStore.layer.pipe(Layer.provideMerge(guidanceDb(directory)), Layer.provide(sequentialIds()));

// every use opens the client and the store afresh and closes them again, as a process restart would
const withStore = <A, E>(directory: string, use: (store: SupervisorConversationStoreShape, db: GuidanceDb["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* SupervisorConversationStore, yield* GuidanceDb);
  }).pipe(Effect.provide(layer(directory)));

const requestCount = (db: GuidanceDb["Service"]) =>
  Effect.map(rows(db, "SELECT count(*) AS n FROM supervisor_conversation_requests"), ([row]) => Number(row?.n));
const reviewInput = (supervisorThreadId: string) => ({projectId, supervisorThreadId, kind: "review" as const, taskId: null, text: "Review.", batch: null, completionMarker: "done"});
const candidate = (taskId: string, proposalId: string, at: number): WorkflowAgreementCandidate => ({taskId, projectId, proposalId, planHash: `hash-${proposalId}`,
  workflow: {status: "proposed", message: "Draft.", workspaceRoot: "/work", revision: "r1", globalRevision: null, definitionsStatus: "ready",
    definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null},
  evidence: {kind: "supervisor_message", messageId: `message-${proposalId}`, runId: "run", runOrdinal: 1, textHash: "text"}, proposedAt: at});

// a yield every eight operations interleaves concurrent fibers between any two statements that are not one transaction
const forcedYields = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, 8);

describe("SupervisorConversationStore", () => {
  it.live("CT-CSTORE-01: prepare() beside a pending request throws supervisor_request_inflight before pruning or inserting", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withStore(directory, (store, db) => Effect.gen(function* () {
      const now = baseTime;
      const row = (id: string, supervisorThreadId: string, state: ConversationRequest["state"], createdAt: number): ConversationRequest =>
        ({...reviewInput(supervisorThreadId), id, messageId: `supervisor-review:${id}`, state, createdAt, sentAt: null, runId: null, error: null});
      // an old completed request that a successful prepare prunes
      yield* store.saveRequest(row("old-completed", "other-supervisor", "completed", now - 31 * 86_400_000));
      for (const state of ["prepared", "sending", "waiting", "uncertain"] as const) {
        yield* store.saveRequest(row(`pending-${state}`, "supervisor-a", state, now));
        const count = yield* requestCount(db);
        const refused = yield* Effect.flip(store.prepare(reviewInput("supervisor-a"), now + 1));
        assert.ok(refused instanceof RequestInflight);
        assert.equal(refused.message, "supervisor_request_inflight");
        assert.equal(yield* requestCount(db), count, state);
        assert.equal((yield* store.requests(projectId, "other-supervisor")).length, 1, `${state}: nothing was pruned`);
        yield* store.saveRequest(row(`pending-${state}`, "supervisor-a", "completed", now));
      }
      assert.equal(yield* requestCount(db), 5);
      const next = yield* store.prepare(reviewInput("supervisor-a"), now + 2);
      assert.equal(next.state, "prepared");
      assert.equal(yield* requestCount(db), 5, "the successful prepare pruned the old completed request and inserted one");
      assert.equal((yield* store.requests(projectId, "other-supervisor")).length, 0);
      // the request identity comes from SupervisorIds and names the native message
      assert.deepEqual([next.id, next.messageId], ["00000000-0000-4000-8000-000000000001", "supervisor-review:00000000-0000-4000-8000-000000000001"]);
    }));
  }), { timeout: 10_000 });

  it.live("CT-CSTORE-02: concurrent prepare() for one Supervisor creates exactly one row and concurrent candidates with one proposalId save one and conflict the other", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store, db) => Effect.gen(function* () {
      const prepares = yield* forcedYields(Effect.all(Array.from({ length: 8 }, (_, index) =>
        Effect.result(store.prepare({...reviewInput("supervisor-a"), text: `Review ${index}.`}, baseTime + index))), { concurrency: "unbounded" }));
      const candidates = yield* forcedYields(Effect.all([
        store.saveAgreementCandidate(candidate("task-a", "proposal", 1)),
        store.saveAgreementCandidate({...candidate("task-a", "proposal", 1), planHash: "other-hash"}),
      ], { concurrency: "unbounded" }));
      return {
        prepared: prepares.filter((result) => result._tag === "Success").length,
        inflight: prepares.filter((result) => result._tag === "Failure" && result.failure instanceof RequestInflight).length,
        rows: yield* requestCount(db),
        candidates: [...candidates].sort(),
        stored: (yield* store.agreementCandidates("task-a")).map((stored) => stored.planHash),
      };
    }));
    assert.deepEqual(observed, { prepared: 1, inflight: 7, rows: 1, candidates: ["conflict", "saved"], stored: ["hash-proposal"] });
  }), { timeout: 10_000 });

  it.live("concurrent review misses count every miss once and concurrent agreement evidence stays write-once under forced fiber yields", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store) => Effect.gen(function* () {
      yield* store.noticeSent("supervisor-a", 1);
      yield* store.saveAgreementCandidate(candidate("task-a", "proposal", 1));
      const misses = yield* forcedYields(Effect.all(Array.from({ length: 8 }, () => store.missedReview("supervisor-a")), { concurrency: "unbounded" }));
      yield* forcedYields(Effect.all(Array.from({ length: 4 }, (_, index) => store.saveAgreementEvidence("task-a", "proposal", `agent-${index}`, `hash-${index}`)),
        { concurrency: "unbounded" }));
      const stored = yield* store.agreementCandidate("task-a", "proposal");
      return { misses: [...misses].sort((left, right) => left - right), evidence: [stored?.agentMessageId, stored?.agentTextHash] };
    }));
    assert.deepEqual(observed.misses, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(observed.evidence, ["agent-0", "hash-0"], "the first evidence written is never replaced");
  }), { timeout: 10_000 });

  it.live("CT-CSTORE-03: a request saved 'sending' survives reopen unchanged and the layer recovers nothing", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const sending = yield* withStore(directory, (store) => Effect.gen(function* () {
      const prepared = yield* store.prepare(reviewInput("supervisor-a"), baseTime);
      const value: ConversationRequest = {...prepared, state: "sending", sentAt: baseTime};
      yield* store.saveRequest(value);
      return value;
    }));
    assert.deepEqual(yield* withStore(directory, (store) => store.pending(projectId, "supervisor-a")), sending);
    assert.deepEqual(yield* withStore(directory, (store) => store.requests(projectId)), [sending]);
  }), { timeout: 10_000 });

  it.live("CT-CSTORE-04: agreement evidence is write-once and candidates are full at 50 per task and 5000 per project", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withStore(directory, (store, db) => Effect.gen(function* () {
      assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", "p-0", 1)), "saved");
      yield* store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-1");
      yield* store.saveAgreementEvidence("task-0", "p-0", "agent-2", "hash-2");
      yield* store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-other");
      yield* store.saveAgreementEvidence("task-0", "p-0", "agent-1", "hash-1");
      const stored = yield* store.agreementCandidate("task-0", "p-0");
      assert.deepEqual([stored?.agentMessageId, stored?.agentTextHash], ["agent-1", "hash-1"]);
      yield* store.saveAgreementEvidence("task-0", "missing", "agent-1", "hash-1");
      assert.equal(yield* store.agreementCandidate("task-0", "missing"), null);

      for (let index = 1; index < 50; index++) assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", `p-${index}`, index)), "saved");
      assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", "p-50", 50)), "full");
      assert.equal(yield* store.saveAgreementCandidate(candidate("task-0", "p-1", 1)), "same");
      assert.equal(yield* store.saveAgreementCandidate({...candidate("task-0", "p-1", 1), planHash: "changed"}), "conflict");
      // one transaction keeps the 4950 store writes from paying a synchronous commit each
      yield* db.withTransaction(Effect.gen(function* () {
        for (let task = 1; task < 100; task++)
          for (let index = 0; index < 50; index++) assert.equal(yield* store.saveAgreementCandidate(candidate(`task-${task}`, `p-${index}`, index)), "saved");
      }));
      assert.equal((yield* store.agreementCandidates("task-99")).length, 50);
      assert.equal(yield* store.saveAgreementCandidate(candidate("task-100", "p-0", 0)), "full");
      assert.equal((yield* store.agreementCandidates("task-100")).length, 0);
    }));
  }), { timeout: 10_000 });

  it.live("CT-CSTORE-04: prune never deletes uncertain or unacknowledged failed review requests", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withStore(directory, (store, db) => Effect.gen(function* () {
      const now = baseTime;
      const old = now - 31 * 86_400_000;
      const save = (id: string, state: ConversationRequest["state"], kind: ConversationRequest["kind"], extra: Partial<ConversationRequest> = {}) =>
        store.saveRequest({...reviewInput(`supervisor-${id}`), kind, id, messageId: `supervisor-review:${id}`, state, createdAt: old, sentAt: null, runId: null, error: null, ...extra});
      yield* save("completed", "completed", "review");
      yield* save("failed-context", "failed", "context");
      yield* save("failed-review-acknowledged", "failed", "review", {failureAcknowledged: true});
      yield* save("failed-review", "failed", "review");
      yield* save("uncertain", "uncertain", "review");
      yield* save("waiting", "waiting", "review");
      // more than 100 terminal requests of one Supervisor keep only the newest 100 terminal ones
      for (let index = 0; index < 101; index++)
        yield* store.saveRequest({...reviewInput("supervisor-many"), id: `many-${String(index).padStart(3, "0")}`, messageId: `m-${index}`, state: "completed",
          createdAt: now - 1_000 + index, sentAt: null, runId: null, error: null});
      yield* store.saveRequest({...reviewInput("supervisor-many"), id: "many-uncertain", messageId: "m-uncertain", state: "uncertain", createdAt: now - 2_000, sentAt: null, runId: null, error: null});
      yield* store.saveRequest({...reviewInput("supervisor-many"), id: "many-failed", messageId: "m-failed", state: "failed", createdAt: now - 2_000, sentAt: null, runId: null, error: null});
      yield* store.prune(now);
      const remaining = new Set((yield* rows(db, "SELECT id FROM supervisor_conversation_requests")).map((row) => String(row.id)));
      for (const id of ["failed-review", "uncertain", "waiting", "many-uncertain", "many-failed"]) assert.ok(remaining.has(id), id);
      for (const id of ["completed", "failed-context", "failed-review-acknowledged", "many-000"]) assert.equal(remaining.has(id), false, id);
      assert.equal([...remaining].filter(id => id.startsWith("many-") && /\d$/u.test(id)).length, 100);
    }));
  }), { timeout: 10_000 });

  it.live("R19: a stored request that does not decode fails pending() and prepare() typed instead of reading as absent", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store, db) => Effect.gen(function* () {
      yield* db`INSERT INTO supervisor_conversation_requests VALUES('broken',${projectId},'{"supervisorThreadId":"supervisor-a","state":"dispatching"}',${baseTime})`;
      const pending = yield* Effect.flip(store.pending(projectId, "supervisor-a"));
      const prepare = yield* Effect.flip(store.prepare(reviewInput("supervisor-a"), baseTime + 1));
      return { pending, prepare, rows: yield* requestCount(db) };
    }));
    for (const failure of [observed.pending, observed.prepare]) {
      assert.ok(failure instanceof GuidanceStoreError);
      assert.deepEqual([failure.reason, failure.row], ["row_invalid", "conversation_request"]);
    }
    assert.equal(observed.rows, 1, "no second in-flight request was prepared");
  }), { timeout: 10_000 });

  it.live("stored documents keep unknown keys and their exact bytes through reads and write-once evidence", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store, db) => Effect.gen(function* () {
      const stored = {extra: {kept: true}, ...candidate("task-a", "p-a", 1)};
      yield* db`INSERT INTO supervisor_workflow_agreement_candidates VALUES('task-a','p-a',${projectId},${JSON.stringify(stored)},1)`;
      const read = yield* store.agreementCandidate("task-a", "p-a");
      yield* store.saveAgreementEvidence("task-a", "p-a", "agent", "agent-hash");
      const [row] = yield* rows(db, "SELECT document FROM supervisor_workflow_agreement_candidates WHERE task_id='task-a'");
      return { stored, read, document: row?.document };
    }));
    assert.deepEqual(observed.read, observed.stored);
    assert.equal(observed.document, JSON.stringify({...observed.stored, agentMessageId: "agent", agentTextHash: "agent-hash"}));
  }), { timeout: 10_000 });

  it.live("a candidate decodes either evidence as the typed submission and the cut-over write it, while a pre-conversion row is invalid", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store, db) => Effect.gen(function* () {
      // a retained initial candidate the cut-over converted in place: the old provenance fields replaced by the message evidence
      const converted = {...candidate("task-a", "p-a", 1), interpretation: true, retainedKey: "kept",
        evidence: {kind: "supervisor_message", messageId: "answer", runId: "run", runOrdinal: 0, textHash: "hash", stale: true}};
      const submitted = {...candidate("task-a", "p-b", 2), interpretation: true, evidence: {kind: "interpretation_submission", taskId: "task-a",
        attemptId: "interpretation-attempt:1b4e28ba-2fa1-41d2-883f-0016d3cca427", itemId: "item", runId: "run", argumentsHash: "a".repeat(64),
        sourcePin: {messageId: "source", runId: "source-run", ordinal: 1, hash: "b".repeat(64)}, planDigest: null}};
      const {taskId, proposalId, planHash, workflow, proposedAt} = candidate("task-a", "p-c", 3);
      const legacy = {taskId, projectId, proposalId, planHash, workflow, proposedAt, interpretation: true,
        supervisorMessageId: "answer", supervisorRunId: "run", supervisorRunOrdinal: 0, supervisorTextHash: "hash"};
      for (const [index, document] of [converted, submitted, legacy].entries())
        yield* db`INSERT INTO supervisor_workflow_agreement_candidates VALUES('task-a',${document.proposalId},${projectId},${JSON.stringify(document)},${index})`;
      return {converted, submitted, read: [yield* store.agreementCandidate("task-a", "p-a"), yield* store.agreementCandidate("task-a", "p-b")],
        legacy: yield* Effect.flip(store.agreementCandidate("task-a", "p-c"))};
    }));
    assert.deepEqual(observed.read, [observed.converted, observed.submitted]);
    assert.ok(observed.legacy instanceof GuidanceStoreError);
    assert.equal(observed.legacy.reason, "row_invalid");
  }), { timeout: 10_000 });

  it.live("introductions: an attempted one is retained, a never-dispatched draft is removed, and rejected attempts without a dispatch mode decode", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store) => Effect.gen(function* () {
      const draft = (taskId: string, extra: Partial<WorkflowIntroduction> = {}): WorkflowIntroduction => ({taskId, projectId, threadId: "main",
        supervisorThreadId: "supervisor-a", state: "ready", text: "Intro", messageId: `intro-${taskId}`, targetRunId: null, error: null, ...extra});
      yield* store.saveIntroduction(draft("unsent"));
      yield* store.saveIntroduction(draft("dispatching", {dispatchMode: {type: "queue_after_active"}}));
      yield* store.saveIntroduction(draft("rejected", {state: "blocked", rejectedAttempts: [{messageId: "m", commandId: "c", dispatchMode: undefined}]}));
      yield* store.saveIntroduction(draft("sending", {state: "sending"}));
      for (const taskId of ["unsent", "dispatching", "rejected", "sending"]) yield* store.removeUnsentIntroduction(taskId);
      return { remaining: (yield* store.introductions(projectId)).map((introduction) => introduction.taskId).sort(), rejected: yield* store.introduction("rejected") };
    }));
    assert.deepEqual(observed.remaining, ["dispatching", "rejected", "sending"]);
    assert.deepEqual(observed.rejected?.rejectedAttempts, [{messageId: "m", commandId: "c"}]);
  }), { timeout: 10_000 });

  it.live("candidate pruning, the notice clock and review misses keep the synchronous store's results", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const observed = yield* withStore(directory, (store) => Effect.gen(function* () {
      for (const taskId of ["task-a", "task-b", "task-c"]) yield* store.saveAgreementCandidate(candidate(taskId, "p", 1));
      yield* store.pruneAgreementCandidates([]);
      yield* store.pruneAgreementCandidates(["task-a", "task-b"]);
      yield* store.clearAgreementCandidates("task-c");
      const left = yield* Effect.forEach(["task-a", "task-b", "task-c"], (taskId) => Effect.map(store.agreementCandidates(taskId), (list) => list.length));
      const before = [yield* store.lastNotice("supervisor-a"), yield* store.reviewMisses("supervisor-a"), yield* store.missedReview("supervisor-a")];
      yield* store.noticeSent("supervisor-a", 10);
      yield* store.noticeSent("supervisor-a", 20);
      const misses = [yield* store.missedReview("supervisor-a"), yield* store.missedReview("supervisor-a"), yield* store.reviewMisses("supervisor-a"),
        yield* store.reviewMisses("supervisor-a", true), yield* store.missedReview("supervisor-a")];
      return { left, before, last: yield* store.lastNotice("supervisor-a"), misses };
    }));
    assert.deepEqual(observed, { left: [0, 0, 0], before: [null, 0, 0], last: 20, misses: [1, 2, 2, 0, 1] });
  }), { timeout: 10_000 });

  it.live("a prepare inside the caller's transaction rolls back with it and the layer adds the review_misses column to an older clock table", () => Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    yield* withStore(directory, (_store, db) => Effect.gen(function* () {
      yield* db.unsafe("DROP TABLE supervisor_monitor_binding_clock");
      yield* db.unsafe("CREATE TABLE supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL)");
      yield* db`INSERT INTO supervisor_monitor_binding_clock VALUES('supervisor-a',5)`;
    }).pipe(Effect.orDie));
    const observed = yield* withStore(directory, (store, db) => Effect.gen(function* () {
      const failed = yield* Effect.flip(db.withTransaction(Effect.gen(function* () {
        yield* store.prepare(reviewInput("supervisor-a"), baseTime);
        return yield* Effect.fail("caller failed" as const);
      })));
      return { failed, rows: yield* requestCount(db), clock: yield* rows(db, "SELECT * FROM supervisor_monitor_binding_clock"), misses: yield* store.missedReview("supervisor-a") };
    }));
    assert.deepEqual(observed, { failed: "caller failed", rows: 0, clock: [{ supervisor_thread_id: "supervisor-a", last_notice_at: 5, review_misses: 0 }], misses: 1 });
  }), { timeout: 10_000 });
});
