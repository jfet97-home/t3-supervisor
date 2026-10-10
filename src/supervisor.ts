import { Cause, Effect, Schedule } from "effect";
import { createServer } from "node:http";
import { buildContext, formatReplyParts, telegramRouteUpdateId, eligibleRuns, formatMessage, isMainThread, timestampMs } from "./domain.js";
import { Recapper } from "./recap.js";
import { Store, StoreError, type StoreShape, type StoreStats } from "./store.js";
import { T3Client, T3TransportError } from "./t3.js";
import { TelegramClient } from "./telegram.js";
import type { SupervisorConfig } from "./types.js";
import type { InputStoreCapacity } from "./input-store.js";
import { runGuidanceApplication } from "./guidance-application.js";

export interface SupervisorStatus {
  startedAt: string;
  activation: string | null;
  environmentId: string | null;
  t3Connected: boolean;
  storeState: "starting" | "ready" | "degraded";
  modelState: "idle" | "ready" | "degraded";
  telegramState: "starting" | "ready" | "degraded";
  deliveryState: "idle" | "ready" | "degraded";
  heartbeat: number;
  scanHeartbeat: number;
  deliveryHeartbeat: number;
  deliveryBusySince: number | null;
  model: "gpt-6-luna";
  reasoning: "max";
  lastModelSuccessAt: string | null;
  lastDeliveryAt: string | null;
  lastErrorPhase: string | null;
  inputState: "disabled" | "starting" | "ready" | "degraded";
  inputHeartbeat: number;
  inputRequests: number;
  inputUncertain: number;
  inputMessages: number;
  inputPendingCleanup: number;
  inputReplyCleanupExpired: number;
  inputLastErrorPhase: string | null;
  inputCapacity: InputStoreCapacity | null;
  store: StoreStats | null;
}

export const createStatus = (): SupervisorStatus => ({
  inputReplyCleanupExpired: 0,
  startedAt: new Date().toISOString(), activation: null, environmentId: null,
  t3Connected: false, storeState: "starting", modelState: "idle", telegramState: "starting",
  deliveryState: "idle",
  heartbeat: Date.now(), scanHeartbeat: Date.now(), deliveryHeartbeat: Date.now(), deliveryBusySince: null,
  model: "gpt-6-luna", reasoning: "max",
  lastModelSuccessAt: null, lastDeliveryAt: null, lastErrorPhase: null, store: null,
  inputState: "disabled", inputHeartbeat: Date.now(), inputRequests: 0, inputUncertain: 0,
  inputMessages: 0, inputPendingCleanup: 0, inputLastErrorPhase: null, inputCapacity: null,
});

const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
  Effect.sync(() => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));

const guard = <A, E, R>(effect: Effect.Effect<A, E, R>, phase: string, status: SupervisorStatus) =>
  effect.pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    status.lastErrorPhase = phase;
    if (phase === "maintenance" || phase === "scan" || phase === "delivery") status.storeState = "degraded";
    return log("operation_deferred", { phase }).pipe(Effect.andThen(Effect.sleep("10 seconds")));
  }));

export const readiness = (status: SupervisorStatus, config: SupervisorConfig, now = Date.now()) => {
  const alive = now - status.heartbeat < 60_000;
  const scanProgress = now - status.scanHeartbeat < 120_000;
  const inputProgress = status.inputState === "disabled" ||
    (status.inputState === "ready" && now - status.inputHeartbeat < 120_000);
  const deliveryProgress = status.deliveryBusySince === null
    ? now - status.deliveryHeartbeat < 120_000
    : now - status.deliveryBusySince < config.modelTimeoutMs * 2 + 60_000;
  const ready = alive && scanProgress && deliveryProgress && inputProgress && status.activation !== null &&
    status.t3Connected && status.storeState === "ready" && status.telegramState === "ready" &&
    status.modelState !== "degraded" && status.deliveryState !== "degraded" &&
    (status.store?.jobs.unknown ?? 0) === 0 &&
    (status.store?.deferredHints ?? 0) === 0;
  return { alive, ready, scanProgress, deliveryProgress, inputProgress };
};

const healthServer = (config: SupervisorConfig, status: SupervisorStatus) => Effect.acquireRelease(
  Effect.tryPromise(() => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url !== "/health" && request.url !== "/live") {
        response.writeHead(404).end();
        return;
      }
      const health = readiness(status, config);
      const healthy = request.url === "/live" ? health.alive : health.ready;
      response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: healthy, readiness: health, ...status }));
    });
    server.once("error", reject);
    server.listen(config.healthPort, "0.0.0.0", () => resolve(server));
  })),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

const settleInterruptedSend = (store: StoreShape, jobId: string) => Effect.gen(function* () {
  const job = yield* store.getJob(jobId);
  if (job?.state === "sending") yield* store.markUnknown(jobId, "interrupted_send", Date.now());
}).pipe(Effect.orElseSucceed(() => undefined));

export const refreshTelegramStatus = (status: SupervisorStatus) => Effect.gen(function* () {
  const telegram = yield* TelegramClient;
  yield* telegram.getBotInfo();
  status.telegramState = "ready";
}).pipe(Effect.catch(() => Effect.sync(() => {
  status.telegramState = "degraded";
  status.lastErrorPhase = "telegram";
})));

export const runSupervisor = (config: SupervisorConfig, status: SupervisorStatus) => Effect.gen(function* () {
  const store = yield* Store;
  const t3 = yield* T3Client;
  const recapper = yield* Recapper;
  const telegram = yield* TelegramClient;
  yield* healthServer(config, status);
  yield* store.recoverSending(Date.now());
  yield* log("supervisor_started", { model: status.model, reasoning: status.reasoning });

  const maintenance = Effect.gen(function* () {
    status.heartbeat = Date.now();
    status.store = yield* store.stats();
    yield* store.prune(Date.now());
    status.storeState = "ready";
    if (readiness(status, config).ready) status.lastErrorPhase = null;
    yield* Effect.sleep("30 seconds");
  }).pipe((effect) => guard(effect, "maintenance", status), Effect.forever);
  yield* Effect.forkScoped(maintenance);

  const descriptor = yield* t3.descriptor().pipe(
    Effect.tapError(() => Effect.sync(() => { status.lastErrorPhase = "t3_authentication"; })),
    Effect.retry(Schedule.spaced("10 seconds")),
  );
  const activatedAt = yield* store.activate(descriptor.environmentId, Date.now());
  status.environmentId = descriptor.environmentId;
  status.activation = new Date(activatedAt).toISOString();
  if (config.uiPort !== undefined) yield* Effect.forkScoped(runGuidanceApplication(config,store,t3));

  const watch = Effect.gen(function* () {
    const cursor = yield* store.cursor("active");
    yield* t3.watch(cursor === 0 ? undefined : cursor, (item) => store.ingest(item).pipe(
      Effect.tap(() => Effect.sync(() => { status.t3Connected = true; })),
    ));
  }).pipe(
    Effect.ensuring(Effect.sync(() => { status.t3Connected = false; })),
    (effect) => guard(effect, "t3_stream", status),
    Effect.forever,
  );

  const scan = Effect.gen(function* () {
    status.scanHeartbeat = Date.now();
    const hints = yield* store.dueHints(Date.now(), 20);
    for (const hint of hints) {
      yield* Effect.gen(function* () {
        if (config.excludedThreadIds.includes(hint.threadId) || (hint.shell && !isMainThread(hint.shell))) {
          yield* store.doneHint(hint.threadId, hint.revision);
          return;
        }
        const snapshot = yield* t3.projection(hint.threadId);
        const projection = snapshot.projection;
        const project = yield* store.project(hint.threadId);
        for (const run of eligibleRuns(projection, activatedAt)) {
          if (yield* store.hasIdentity(descriptor.environmentId, hint.threadId, run.id)) continue;
          const updateId = telegramRouteUpdateId(projection, run);
          if (updateId !== null) {
            const parts = yield* Effect.try(() => formatReplyParts(projection, run, project));
            const jobId = yield* store.enqueueReply(descriptor.environmentId, hint.threadId, run.id, parts, Date.now());
            if (jobId) yield* log("telegram_reply_queued", { jobId, threadId: hint.threadId, runId: run.id, updateId, parts: parts.length });
          } else {
            const context = yield* Effect.try(() => buildContext(projection, run.id, project));
            const jobId = yield* store.enqueue(descriptor.environmentId, hint.threadId, run.id, context, Date.now());
            if (jobId) yield* log("completion_queued", { jobId, threadId: hint.threadId, runId: run.id });
          }
        }
        let waitingForCompletion = false;
        for (const run of projection.runs) {
          const completedAt = timestampMs(run.completedAt);
          if (run.status === "completed" && completedAt !== null && completedAt > activatedAt &&
            !(yield* store.hasIdentity(descriptor.environmentId, hint.threadId, run.id))) {
            waitingForCompletion = true;
            break;
          }
        }
        if (waitingForCompletion) yield* store.deferHint(hint.threadId, hint.revision, Date.now(), 5_000, "settling");
        else yield* store.doneHint(hint.threadId, hint.revision);
      }).pipe(Effect.catch((error) => Effect.gen(function* () {
        status.lastErrorPhase = "thread_scan";
        if (error instanceof StoreError) status.storeState = "degraded";
        if (error instanceof T3TransportError && error.httpStatus === 404) {
          yield* store.doneHint(hint.threadId, hint.revision);
          yield* log("thread_not_found", { threadId: hint.threadId });
        } else {
          yield* store.deferHint(hint.threadId, hint.revision, Date.now(), 60_000);
          yield* log("thread_scan_deferred", { threadId: hint.threadId });
        }
      })));
      status.scanHeartbeat = Date.now();
    }
    yield* Effect.sleep("2 seconds");
  }).pipe((effect) => guard(effect, "scan", status), Effect.forever);

  const deliver = Effect.gen(function* () {
    status.deliveryHeartbeat = Date.now();
    const jobs = yield* store.dueJobs(Date.now(), ["pending", "ready", "unknown"], 10);
    for (const job of jobs) {
      status.deliveryBusySince = Date.now();
      const action = Effect.gen(function* () {
        if (job.state === "pending") {
          if (!job.context) {
            status.modelState = "degraded";
            status.lastErrorPhase = "context_expired";
            yield* store.retry(job.id, "context_expired", Date.now(), 24 * 60 * 60 * 1_000);
            yield* log("recap_context_expired", { jobId: job.id });
            return;
          }
          const recap = yield* recapper.recap(job.context);
          status.modelState = "ready";
          status.lastModelSuccessAt = new Date().toISOString();
          if (recap === null) {
            if (yield* store.skipRecap(job.id)) yield* log("recap_skipped", { jobId: job.id });
            return;
          }
          const text = yield* Effect.try(() => formatMessage(job.context!.thread, job.context!.project, recap));
          yield* store.setReady(job.id, text, Date.now());
          yield* log("recap_prepared", { jobId: job.id, words: recap.trim().split(/\s+/u).length });
        } else if (job.state === "unknown") {
          const delivery = yield* telegram.getDeliveryStatus(job.deliveryKey);
          if (delivery.state === "sent" && delivery.messageId !== null) {
            yield* store.markSent(job.id, delivery.messageId, Date.now());
            status.deliveryState = "ready";
            status.lastDeliveryAt = new Date().toISOString();
            yield* log("delivery_reconciled", { jobId: job.id, messageId: delivery.messageId });
          } else {
            status.telegramState = "degraded";
            status.deliveryState = "degraded";
            yield* store.markUnknown(job.id, "delivery_unconfirmed", Date.now());
          }
        } else if (job.state === "ready") {
          yield* telegram.getBotInfo();
          status.telegramState = "ready";
          if (job.text === null || !(yield* store.claimSend(job.id, Date.now()))) return;
          yield* Effect.gen(function* () {
            const result = yield* telegram.sendMessage(job.deliveryKey, job.text!);
            if (result.kind === "sent") {
              yield* store.markSent(job.id, result.messageId, Date.now());
              status.lastDeliveryAt = new Date().toISOString();
              status.deliveryState = "ready";
              yield* log("telegram_sent", { jobId: job.id, messageId: result.messageId });
            } else if (result.kind === "rejected") {
              status.telegramState = "degraded";
              status.deliveryState = "degraded";
              yield* store.rejectSend(job.id, result.reason, Date.now());
              yield* log("telegram_rejected", { jobId: job.id, code: result.telegramCode });
            } else {
              status.telegramState = "degraded";
              status.deliveryState = "degraded";
              yield* store.markUnknown(job.id, result.reason, Date.now());
              yield* log("telegram_uncertain", { jobId: job.id });
            }
          }).pipe(Effect.ensuring(settleInterruptedSend(store, job.id)));
        }
      }).pipe(Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        status.lastErrorPhase = "notification";
        if (job.state === "pending") status.modelState = "degraded";
        else { status.telegramState = "degraded"; status.deliveryState = "degraded"; }
        return store.getJob(job.id).pipe(Effect.flatMap((current) => {
          if (current?.state === "unknown") return store.markUnknown(job.id, "notification_failed", Date.now());
          return store.retry(job.id, "notification_failed", Date.now(), 60_000);
        }), Effect.andThen(log("notification_deferred", { jobId: job.id })));
      }));
      yield* action;
      status.deliveryHeartbeat = Date.now();
      status.deliveryBusySince = null;
    }
    yield* Effect.sleep("2 seconds");
  }).pipe((effect) => guard(effect, "delivery", status), Effect.forever);

  const checkTelegram = Effect.gen(function* () {
    yield* refreshTelegramStatus(status);
    yield* Effect.sleep("30 seconds");
  }).pipe(Effect.forever);

  yield* Effect.all([watch, scan, deliver, checkTelegram], { concurrency: "unbounded", discard: true });
});
