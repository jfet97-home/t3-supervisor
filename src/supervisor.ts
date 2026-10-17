import { Cause, Effect, Schedule } from "effect";
import { createServer } from "node:http";
import { Store, type StoreStats } from "./store.js";
import { T3Client } from "./t3.js";
import type { SupervisorConfig } from "./types.js";
import { runGuidanceApplication } from "./guidance-application.js";

export interface SupervisorStatus {
  startedAt: string;
  activation: string | null;
  environmentId: string | null;
  t3Connected: boolean;
  storeState: "starting" | "ready" | "degraded";
  supervisionState: "disabled" | "starting" | "ready" | "degraded";
  heartbeat: number;
  lastErrorPhase: string | null;
  store: StoreStats | null;
}

export const createStatus = (config?: Pick<SupervisorConfig, "uiPort">): SupervisorStatus => ({
  startedAt: new Date().toISOString(),
  activation: null,
  environmentId: null,
  t3Connected: false,
  storeState: "starting",
  supervisionState: config?.uiPort === undefined ? "disabled" : "starting",
  heartbeat: Date.now(),
  lastErrorPhase: null,
  store: null,
});

const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
  Effect.sync(() => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));

const guard = <A, E, R>(effect: Effect.Effect<A, E, R>, phase: string, status: SupervisorStatus) =>
  effect.pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    status.lastErrorPhase = phase;
    if (phase === "maintenance") status.storeState = "degraded";
    return log("operation_deferred", { phase }).pipe(Effect.andThen(Effect.sleep("10 seconds")));
  }));

export const readiness = (status: SupervisorStatus, config: SupervisorConfig, now = Date.now()) => {
  const alive = now - status.heartbeat < 60_000;
  const supervisionProgress = config.uiPort === undefined || status.supervisionState === "ready";
  const ready = supervisionProgress && alive && status.activation !== null && status.t3Connected && status.storeState === "ready";
  return { alive, ready, supervisionProgress };
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

export const runSupervisor = (config: SupervisorConfig, status: SupervisorStatus) => Effect.gen(function* () {
  const store = yield* Store;
  const t3 = yield* T3Client;
  yield* healthServer(config, status);
  yield* log("supervisor_started");

  const maintenance = Effect.gen(function* () {
    status.heartbeat = Date.now();
    status.store = yield* store.stats();
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
  if (config.uiPort !== undefined) {
    status.supervisionState = "starting";
    const supervision = Effect.suspend(() => runGuidanceApplication(config, store, t3, () => {
      status.supervisionState = "ready";
      if (status.lastErrorPhase === "supervision") status.lastErrorPhase = null;
    })).pipe(
      Effect.scoped,
      Effect.catchCause(cause => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        status.supervisionState = "degraded";
        status.lastErrorPhase = "supervision";
        return log("supervision_unavailable").pipe(Effect.andThen(Effect.sleep("10 seconds")));
      }),
      Effect.forever,
    );
    yield* Effect.forkScoped(supervision);
  }

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

  yield* watch;
});
