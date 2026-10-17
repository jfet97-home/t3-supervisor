import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer } from "effect";
import { Recapper } from "../src/recap.js";
import { Store, makeStore } from "../src/store.js";
import { createStatus, readiness, refreshTelegramStatus, runSupervisor } from "../src/supervisor.js";
import { T3Client, type T3ClientShape } from "../src/t3.js";
import { TelegramClient, type DeliveryStatus } from "../src/telegram.js";
import type { Projection, SupervisorConfig, ThreadInfo } from "../src/types.js";

const excluded = "af0e5160-07d2-46c9-b60b-a329d6951d83";
const teamsThread = "9fbd0b1f-5f41-4708-85db-a3cf736789a7";

for (const mode of ["normal", "settling", "rejected", "skipped", "continued", "telegram", "resumed"] as const) test(`coordinator handles ${mode} completion without duplicate or premature delivery`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-coordinator-"));
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "/unused",
    mcpxUrl: "http://unused", cxCommand: "unused", cxHome: "/unused", cxSeedFile: "/unused",
    excludedThreadIds: [excluded, teamsThread], healthPort: 0, modelTimeoutMs: 100,
    telegramEnabled: true,
  };
  const status = createStatus(config);
  const fetched: string[] = [];
  const contexts: string[] = [];
  const deliveries: Array<{ key: string; text: string }> = [];
  let completed!: () => void;
  const delivered = new Promise<void>((resolve) => { completed = resolve; });
  let projection!: Projection;
  let projectionReads = 0;

  const source: T3ClientShape = {
    descriptor: () => Effect.gen(function* () {
      if (mode === "resumed") yield* Effect.sleep("200 millis");
      return { environmentId: "environment-test", orchestrationProtocolVersion: 2, serverVersion: "test" };
    }),
    projection: threadId => source.boundedCompletionProjection!(threadId),
    boundedCompletionProjection: (threadId) => Effect.sync(() => {
      fetched.push(threadId);
      projectionReads += 1;
      const completeProjection = {...projection, nodes: projection.nodes as Array<Record<string, unknown>>,
        runtimeRequests: [], turnItems: projection.turnItems ?? [], subagents: [], providerThreads: []};
      return { snapshotSequence: 1, historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: null, payloadBudgetExceeded: false, projection: mode === "settling" && projectionReads === 1
        ? { ...completeProjection, subagents: [{ status: "completed", completionDelivery: { state: "claimed" } }] }
        : completeProjection };
    }),
    watch: (_cursor, onItem) => Effect.gen(function* () {
      const completedAt = new Date(Date.now() + 100).toISOString();
      const thread: ThreadInfo = {
        id: "main-thread", title: "Service deployment", projectId: "project",
        lineage: { parentThreadId: null, relationshipToParent: null },
        latestRunCompletedAt: completedAt, status: "completed",
        activeRunId: null, activityRunStatus: null, pendingRuntimeRequest: null, pendingBackgroundTasks: [],
      };
      projection = {
        thread,
        nodes: [
          { id: "root", kind: "root_turn", threadId: thread.id, runId: "run", rootNodeId: "root", parentNodeId: null, providerThreadId: "provider", status: "completed" },
          { id: "answer-node", kind: "assistant_message", threadId: thread.id, runId: "run", rootNodeId: "root", parentNodeId: "root", providerThreadId: "provider", status: "completed" },
        ],
        runs: [{ id: "run", threadId: thread.id, providerThreadId: "provider", ordinal: 1, status: "completed", requestedAt: completedAt, startedAt: completedAt, completedAt, rootNodeId: "root", userMessageId: "request" }],
        messages: [{ id: "request", threadId: thread.id, runId: "run", nodeId: "root", role: "user", text: "Configure restart behavior and verify the service.", streaming: false, createdAt: completedAt, updatedAt: completedAt }, { id: "answer", threadId: thread.id, runId: "run", nodeId: "answer-node", role: "assistant", text: "Configured restart unless stopped; the service works.", streaming: false, createdAt: completedAt, updatedAt: completedAt }],
      };
      if (mode === "telegram") {
        const requestId = "message:mcp:90d829bb-aada-40db-b243-797c00ac8f36:thread-send:telegram-route-135456335";
        projection.runs[0]!.userMessageId = requestId;
        projection.messages[0] = {
          id: requestId, threadId: thread.id, runId: "run", nodeId: "root", role: "user", text: "Just confirm?",
          streaming: false, createdAt: completedAt, updatedAt: completedAt,
        };
        projection.messages[1]!.text = "Yes, exactly. " + "Every word stays in the original answer. ".repeat(10);
      }
      if (mode === "continued") {
        projection.thread = { ...thread, activeRunId: "next-run", activityRunStatus: "running" };
        projection.runs.push({
          id: "next-run", threadId: thread.id, providerThreadId: "provider", ordinal: 2,
          status: "running", requestedAt: completedAt, startedAt: completedAt, completedAt: null, rootNodeId: "next-root",
        });
        projection.turnItems = [{ type: "dynamic_tool", status: "running", runId: "next-run" }];
      }
      if (mode === "resumed") {
        const disabledAt = new Date(Date.now() - 100_000).toISOString();
        projection.runs[0]!.completedAt = disabledAt;
        projection.messages[0]!.createdAt = disabledAt;
        projection.messages[0]!.updatedAt = disabledAt;
      }
      yield* onItem({ stream: "active", item: { kind: "snapshot", snapshot: {
        schemaVersion: 2, snapshotSequence: 1,
        projects: [{ id: "project", title: "Homelab", workspaceRoot: "/work" }],
        threads: [mode === "settling" ? { ...thread, activityRunStatus: "running", activeRunId: "run" } : thread,
          { ...thread, id: excluded }, { ...thread, id: teamsThread, title: "TEAMS" },
          { ...thread, id: "child", lineage: { parentThreadId: thread.id, relationshipToParent: "subagent" } }], archivedThreads: [],
      } } });
      if (mode !== "settling") yield* onItem({ stream: "active", item: { kind: "thread.updated", sequence: 2, thread } });
      return yield* Effect.never;
    }),
  };
  const layers = Layer.mergeAll(
    makeStore(directory),
    Layer.succeed(T3Client, source),
    Layer.succeed(Recapper, { recap: (context) => Effect.sync(() => {
      contexts.push(context.finalAnswer);
      if (mode === "skipped") {
        completed();
        return null;
      }
      return "Configured restart behavior and verified the service.";
    }) }),
    Layer.succeed(TelegramClient, {
      getBotInfo: () => Effect.succeed({ id: 1, isBot: true, firstName: "Bot", username: null }),
      getDeliveryStatus: () => Effect.succeed({ state: "not_found" }),
      sendMessage: (key, text) => Effect.sync(() => {
        deliveries.push({ key, text });
        completed();
        return mode === "rejected"
          ? { kind: "rejected", reason: "telegram_rejected", telegramCode: 403 }
          : { kind: "sent", messageId: 123 };
      }),
    }),
  );
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      if (mode === "resumed") {
        const old = Date.now() - 9 * 24 * 60 * 60 * 1_000;
        yield* store.activate("environment-test", old);
        yield* store.configureTelegram("environment-test", true, old);
        yield* store.enqueue("environment-test", "main-thread", "preserved-run", {
          finalAnswer: "Configured restart unless stopped; the service works.", messages: [],
          thread: { id: "main-thread", title: "Service deployment", projectId: "project", lineage: { parentThreadId: null, relationshipToParent: null } },
          project: { id: "project", title: "Homelab", workspaceRoot: "/work" },
        }, old);
        yield* store.configureTelegram("environment-test", false, old + 1_000);
      }
      yield* Effect.forkScoped(runSupervisor(config, status));
      yield* Effect.tryPromise(async () => {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([delivered, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("coordinator never completed its send attempt")), 20_000);
          })]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      });
      yield* Effect.sleep("100 millis");
      const stats = yield* store.stats();
      assert.equal(stats.jobs.sent, mode === "rejected" || mode === "skipped" ? 0 : 1);
      assert.equal(stats.identities, 1);
      if (mode === "skipped") {
        assert.equal(stats.jobs.pending, 0);
        assert.equal(stats.jobs.ready, 0);
        assert.equal(status.modelState, "ready");
        assert.ok(status.lastModelSuccessAt);
      }
      if (mode === "rejected") {
        assert.equal(status.deliveryState, "degraded");
        yield* refreshTelegramStatus(status);
        assert.equal(status.telegramState, "ready");
        assert.equal(status.deliveryState, "degraded");
        assert.equal(readiness(status, config).ready, true);
      }
    }).pipe(Effect.provide(layers), Effect.scoped));
    assert.equal(fetched.every((id) => id === "main-thread"), true);
    assert.equal(projectionReads, mode === "settling" ? 2 : 1);
    assert.equal(contexts.length, mode === "telegram" ? 0 : 1);
    if (mode === "telegram") {
      assert.ok(deliveries[0]?.text.endsWith(projection.messages[1]!.text));
      assert.match(deliveries[0]?.key ?? "", /-answer-1$/u);
    }
    assert.equal(deliveries.length, mode === "skipped" ? 0 : 1);
    if (mode !== "skipped") {
      assert.match(deliveries[0]!.text, /Homelab/u);
      assert.match(deliveries[0]!.text, /main-thread/u);
    }
    assert.equal(status.lastDeliveryAt !== null, mode !== "rejected" && mode !== "skipped");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness distinguishes process liveness from failed dependencies and stalled workers", () => {
  const config = { modelTimeoutMs: 1000, telegramEnabled: true } as SupervisorConfig;
  const status = createStatus(config);
  assert.equal(readiness(status, config).alive, true);
  assert.equal(readiness(status, config).ready, false);
  status.activation = new Date().toISOString();
  status.t3Connected = true;
  status.storeState = "ready";
  status.telegramState = "ready";
  assert.equal(readiness(status, config).ready, true);
  status.inputState = "starting";
  assert.equal(readiness(status, config).ready, false);
  status.inputState = "ready";
  status.inputHeartbeat = Date.now() - 130_000;
  assert.equal(readiness(status, config).ready, false);
  status.inputHeartbeat = Date.now();
  assert.equal(readiness(status, config).ready, true);
  status.inputState = "degraded";
  assert.equal(readiness(status, config).ready, false);
  status.inputState = "disabled";
  status.modelState = "degraded";
  assert.equal(readiness(status, config).ready, false);
  status.modelState = "ready";
  status.storeState = "degraded";
  assert.equal(readiness(status, config).ready, false);
  status.storeState = "ready";
  status.deliveryState = "degraded";
  status.store = {
    projects: 0, threads: 0, dirtyHints: 0, deferredHints: 0, waitingHints: 0, identities: 0,
    jobs: { pending: 0, ready: 0, sending: 0, sent: 0, unknown: 1 }, databaseBytes: 0,
  };
  assert.equal(readiness(status, config).ready, true);
  status.telegramState = "degraded";
  assert.equal(readiness(status, config).ready, false);
  status.telegramState = "ready";
  status.deliveryState = "ready";
  status.scanHeartbeat = Date.now() - 130_000;
  assert.equal(readiness(status, config).ready, false);
  status.scanHeartbeat = Date.now();
  status.deliveryBusySince = Date.now() - 63_000;
  assert.equal(readiness(status, config).ready, false);
});

const runReconciliationReadinessCase = async (lookupResult: DeliveryStatus, expectedTelegramState: "ready" | "degraded", expectedReady: boolean) => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-delivery-health-"));
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "/unused",
    mcpxUrl: "http://unused", cxCommand: "unused", cxHome: "/unused", cxSeedFile: "/unused",
    excludedThreadIds: [], healthPort: 0, modelTimeoutMs: 100, telegramEnabled: true, inputEnabled: false,
  };
  const status = createStatus(config);
  let releaseLookup!: (result: DeliveryStatus) => void;
  let notifyLookupStarted!: () => void;
  const lookupResultWait = new Promise<DeliveryStatus>((resolve) => { releaseLookup = resolve; });
  const lookupStarted = new Promise<void>((resolve) => { notifyLookupStarted = resolve; });
  let lookupCalls = 0;
  let botInfoCalls = 0;
  let sendCalls = 0;
  const source: T3ClientShape = {
    descriptor: () => Effect.succeed({ environmentId: "delivery-health-test", orchestrationProtocolVersion: 2, serverVersion: "test" }),
    projection: () => Effect.die("No completion projection is expected"),
    watch: (_cursor, onItem) => Effect.gen(function* () {
      yield* onItem({ stream: "active", item: { kind: "snapshot", snapshot: {
        schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [], archivedThreads: [],
      } } });
      return yield* Effect.never;
    }),
  };
  const layers = Layer.mergeAll(
    makeStore(directory),
    Layer.succeed(T3Client, source),
    Layer.succeed(Recapper, { recap: () => Effect.die("Unknown jobs must not be recapped") }),
    Layer.succeed(TelegramClient, {
      getBotInfo: () => Effect.sync(() => {
        botInfoCalls += 1;
        return { id: 1, isBot: true, firstName: "Bot", username: null };
      }),
      getDeliveryStatus: () => Effect.promise(() => {
        lookupCalls += 1;
        notifyLookupStarted();
        return lookupResultWait;
      }),
      sendMessage: () => Effect.sync(() => {
        sendCalls += 1;
        return { kind: "sent", messageId: 123 };
      }),
    }),
  );
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      const seedTime = Date.now() - 120_000;
      yield* store.activate("delivery-health-test", seedTime);
      yield* store.configureTelegram("delivery-health-test", true, seedTime);
      const replyId = yield* store.enqueueReply("delivery-health-test", "old-thread", "old-run", ["Unresolved answer"], seedTime);
      assert.ok(replyId);
      const jobId = `${replyId}-answer-1`;
      yield* store.claimSend(jobId, seedTime);
      yield* store.markUnknown(jobId, "initial_uncertainty", seedTime);
      yield* Effect.forkScoped(runSupervisor(config, status));
      yield* Effect.tryPromise(() => lookupStarted).pipe(Effect.timeout("3 seconds"));
      yield* Effect.gen(function* () {
        if (status.t3Connected && status.telegramState === "ready") return true;
        yield* Effect.sleep("10 millis");
        return false;
      }).pipe(Effect.repeat({ until: Boolean }), Effect.timeout("3 seconds"));
      releaseLookup(lookupResult);
      yield* Effect.gen(function* () {
        const job = yield* store.getJob(jobId);
        if (job?.state === "unknown" && job.error === "delivery_unconfirmed" &&
          status.deliveryState === "degraded" && status.telegramState === expectedTelegramState) return true;
        yield* Effect.sleep("10 millis");
        return false;
      }).pipe(Effect.repeat({ until: Boolean }), Effect.timeout("3 seconds"));
      const stats = yield* store.stats();
      status.store = stats;
      assert.equal(stats.jobs.unknown, 1);
      assert.equal((yield* store.getJob(jobId))?.state, "unknown");
      assert.equal(status.deliveryState, "degraded");
      assert.equal(status.telegramState, expectedTelegramState);
      assert.equal(readiness(status, config).ready, expectedReady);
      assert.equal(lookupCalls, 1);
      assert.equal(botInfoCalls, 1);
      assert.equal(sendCalls, 0);
    }).pipe(Effect.provide(layers), Effect.scoped));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("an unresolved delivery ledger result stays visible without failing health when Telegram is reachable", async () => {
  await runReconciliationReadinessCase({ state: "unknown", reason: "delivery_unknown" }, "ready", true);
});

test("a sent ledger row without a message receipt stays unresolved without degrading Telegram reachability", async () => {
  await runReconciliationReadinessCase({ state: "sent", messageId: null }, "ready", true);
});

test("an invalid delivery lookup response keeps readiness degraded", async () => {
  await runReconciliationReadinessCase({ state: "unknown", reason: "invalid_response" }, "degraded", false);
});

test("a timed out delivery lookup keeps readiness degraded", async () => {
  await runReconciliationReadinessCase({ state: "unknown", reason: "timeout" }, "degraded", false);
});

test("disabled Telegram keeps observation healthy without notification services or changing queued deliveries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-no-telegram-"));
  const config: SupervisorConfig = {
    dataDirectory: directory, t3Url: "http://unused", t3TokenFile: "/unused",
    mcpxUrl: "invalid MCP URL", cxCommand: "missing-runtime", cxHome: "/unused", cxSeedFile: "/unused",
    excludedThreadIds: [], healthPort: 0, modelTimeoutMs: 1,
    telegramEnabled: false, inputEnabled: true,
  };
  const status = createStatus(config);
  const source: T3ClientShape = {
    descriptor: () => Effect.succeed({ environmentId: "environment-test", orchestrationProtocolVersion: 2, serverVersion: "test" }),
    projection: () => Effect.die("disabled notifications must not fetch completion projections"),
    watch: (_cursor, onItem) => Effect.gen(function* () {
      yield* onItem({ stream: "active", item: { kind: "snapshot", snapshot: {
        schemaVersion: 2, snapshotSequence: 1,
        projects: [{ id: "project", title: "Project", workspaceRoot: "/work" }],
        threads: [{ id: "thread", title: "Completed task", projectId: "project", lineage: { parentThreadId: null, relationshipToParent: null }, latestRunCompletedAt: new Date().toISOString() }],
        archivedThreads: [],
      } } });
      return yield* Effect.never;
    }),
  };
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      yield* store.activate("environment-test", Date.now() - 1_000);
      const ids: string[] = [];
      for (const state of ["ready", "sending", "unknown"]) {
        const id = yield* store.enqueueReply("environment-test", "old-thread", state, ["Retained answer"], Date.now() - 100);
        assert.ok(id);
        ids.push(id);
        if (state !== "ready") yield* store.claimSend(id, Date.now());
        if (state === "unknown") yield* store.markUnknown(id, "uncertain", Date.now());
      }
      const before = yield* Effect.all(ids.map((id) => store.getJob(id)));
      yield* Effect.forkScoped(runSupervisor(config, status));
      yield* Effect.gen(function* () {
        const catalog = yield* store.catalog();
        const stats = yield* store.stats();
        if (catalog.threads.length !== 1 || stats.dirtyHints !== 0 || !status.t3Connected) {
          yield* Effect.sleep("20 millis");
          return false;
        }
        return true;
      }).pipe(Effect.repeat({ until: Boolean }), Effect.timeout("5 seconds"));
      const after = yield* Effect.all(ids.map((id) => store.getJob(id)));
      assert.deepEqual(after, before);
      const stats = yield* store.stats();
      assert.equal(stats.identities, 3);
      assert.equal(stats.threads, 1);
      assert.equal(status.telegramState, "disabled");
      assert.equal(status.deliveryState, "disabled");
      assert.equal(status.modelState, "disabled");
      assert.equal(status.inputState, "disabled");
      status.store = stats;
      status.storeState = "ready";
      assert.equal(readiness(status, config).ready, true);
      status.deliveryHeartbeat = 0;
      status.deliveryBusySince = 0;
      status.inputState = "degraded";
      status.modelState = "degraded";
      status.telegramState = "degraded";
      status.deliveryState = "degraded";
      status.store.deferredHints = 1;
      assert.equal(readiness(status, config).ready, true);
      status.t3Connected = false;
      assert.equal(readiness(status, config).ready, false);
    }).pipe(Effect.provide(Layer.mergeAll(makeStore(directory), Layer.succeed(T3Client, source))), Effect.scoped));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("failed supervision startup degrades readiness while the coordinator stays alive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervision-startup-failure-"));
  const config: SupervisorConfig = {dataDirectory: directory, t3Url: "unused", t3TokenFile: join(directory, "missing-read-token"), mcpxUrl: "unused", cxCommand: "unused", cxHome: directory, cxSeedFile: "unused", excludedThreadIds: [], healthPort: 0, modelTimeoutMs: 100, telegramEnabled: false, uiPort: 0, uiHost: "127.0.0.1"};
  const status = createStatus(config);
  const source: T3ClientShape = {
    descriptor: () => Effect.succeed({environmentId: "startup-test", orchestrationProtocolVersion: 2, serverVersion: "fixture"}),
    projection: () => Effect.die("No completion read is expected"),
    watch: (_cursor, onItem) => Effect.gen(function* () {
      yield* onItem({stream: "active", item: {kind: "snapshot", snapshot: {schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [], archivedThreads: []}}});
      return yield* Effect.never;
    }),
  };
  try {
    await Effect.runPromise(Effect.gen(function* () {
      yield* Effect.forkScoped(runSupervisor(config, status));
      yield* Effect.gen(function* () {
        if (status.supervisionState !== "degraded" || !status.t3Connected) {yield* Effect.sleep("10 millis");return false;}
        return true;
      }).pipe(Effect.repeat({until: Boolean}), Effect.timeout("3 seconds"));
      assert.equal(status.lastErrorPhase, "supervision");
      assert.equal(readiness(status, config).alive, true);
      assert.equal(readiness(status, config).ready, false);
      assert.equal(readiness(status, config).supervisionProgress, false);
      status.supervisionState = "ready";status.storeState = "ready";
      assert.equal(readiness(status, config).ready, true);
    }).pipe(Effect.provide(Layer.mergeAll(makeStore(directory), Layer.succeed(T3Client, source))), Effect.scoped));
  } finally {await rm(directory, {recursive: true, force: true});}
});
