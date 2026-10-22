import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { Cause, Clock, Context, Deferred, Effect, FileSystem, Layer, Redacted, Schedule, Schema, SubscriptionRef } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { SupervisorConfig } from "./config.js";
import { failureReason, T3TokenUnavailable } from "./errors.js";
import { runGuidanceApplication } from "./guidance-application.js";
import { logEvent } from "./logging.js";
import { SupervisorOwnership } from "./project-supervisor-store.js";
import { makeStore, Store, type StoreStats } from "./store.js";
import { makeT3Client, T3Client } from "./t3.js";
import { ThreadPolicy } from "./thread-policy.js";
import type { SupervisorSettings } from "./types.js";

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

export const createStatus = (config: Pick<SupervisorSettings, "uiPort">, now: number): SupervisorStatus => ({
  startedAt: new Date(now).toISOString(),
  activation: null,
  environmentId: null,
  t3Connected: false,
  storeState: "starting",
  supervisionState: config.uiPort === undefined ? "disabled" : "starting",
  heartbeat: now,
  lastErrorPhase: null,
  store: null,
});

export const readiness = (status: SupervisorStatus, config: SupervisorSettings, now = Date.now()) => {
  const alive = now - status.heartbeat < 60_000;
  const supervisionProgress = config.uiPort === undefined || status.supervisionState === "ready";
  const ready = supervisionProgress && alive && status.activation !== null && status.t3Connected && status.storeState === "ready";
  return { alive, ready, supervisionProgress };
};

// the current status: written by the maintenance, watch and supervision fibers, read by every health request
export class SupervisorStatusRef extends Context.Service<SupervisorStatusRef, SubscriptionRef.SubscriptionRef<SupervisorStatus>>()(
  "t3-supervisor/SupervisorStatus") {
  static readonly layer: Layer.Layer<SupervisorStatusRef, never, SupervisorConfig> = Layer.effect(SupervisorStatusRef, Effect.gen(function* () {
    const config = yield* SupervisorConfig;
    return yield* SubscriptionRef.make(createStatus(config, yield* Clock.currentTimeMillis));
  }));
}

// the exact request target decides: a query string or a trailing slash is a 404 with an empty body, as any other path
const health = (path: "/health" | "/live") => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.url !== path) return HttpServerResponse.empty({ status: 404 });
  const config = yield* SupervisorConfig;
  const status = yield* SubscriptionRef.get(yield* SupervisorStatusRef);
  const checked = readiness(status, config, yield* Clock.currentTimeMillis);
  const healthy = path === "/live" ? checked.alive : checked.ready;
  return HttpServerResponse.text(JSON.stringify({ ok: healthy, readiness: checked, ...status }),
    { status: healthy ? 200 : 503, contentType: "application/json" });
});

// /health and /live for every method on the health port; the http logger and the listen log stay disabled
const healthServer = Layer.unwrap(SupervisorConfig.useSync((config) => HttpRouter.serve(
  Layer.mergeAll(HttpRouter.add("*", "/health", health("/health")), HttpRouter.add("*", "/live", health("/live"))),
  { disableLogger: true, disableListenLog: true },
).pipe(Layer.provide(NodeHttpServer.layerServer(createServer, { port: config.healthPort, host: "0.0.0.0" })))));

export const runSupervisor = Effect.gen(function* () {
  const config = yield* SupervisorConfig;
  const status = yield* SupervisorStatusRef;
  const store = yield* Store;
  const t3 = yield* T3Client;
  const update = (change: (current: SupervisorStatus) => Partial<SupervisorStatus>) =>
    SubscriptionRef.update(status, (current) => ({ ...current, ...change(current) }));
  yield* Layer.build(healthServer);
  yield* logEvent("supervisor_started");

  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>, phase: string) =>
    effect.pipe(Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return update(() => ({ lastErrorPhase: phase, ...(phase === "maintenance" ? { storeState: "degraded" as const } : {}) })).pipe(
        Effect.andThen(logEvent("operation_deferred", { phase })), Effect.andThen(Effect.sleep("10 seconds")));
    }));

  const maintenance = Effect.gen(function* () {
    const heartbeat = yield* Clock.currentTimeMillis;
    yield* update(() => ({ heartbeat }));
    const stats = yield* store.stats();
    const checked = yield* Clock.currentTimeMillis;
    yield* update((current) => {
      const next = { ...current, store: stats, storeState: "ready" as const };
      return readiness(next, config, checked).ready ? { ...next, lastErrorPhase: null } : next;
    });
    yield* Effect.sleep("30 seconds");
  }).pipe((effect) => guard(effect, "maintenance"), Effect.forever);
  yield* Effect.forkScoped(maintenance);

  const descriptor = yield* t3.descriptor().pipe(
    Effect.tapError(() => update(() => ({ lastErrorPhase: "t3_authentication" }))),
    Effect.retry(Schedule.spaced("10 seconds")),
  );
  const activatedAt = yield* store.activate(descriptor.environmentId, yield* Clock.currentTimeMillis);
  yield* update(() => ({ environmentId: descriptor.environmentId, activation: new Date(activatedAt).toISOString() }));
  if (config.uiPort !== undefined) {
    yield* update(() => ({ supervisionState: "starting" }));
    // unported readers receive the root service values with the configuration (B-02)
    const readers = { ...config, threadPolicy: yield* ThreadPolicy, supervisorOwnedThreadIds: yield* SupervisorOwnership };
    const supervision = Effect.gen(function* () {
      // the application reports readiness through a synchronous callback; within this attempt the status follows it
      const ready = yield* Deferred.make<void>();
      yield* Effect.forkScoped(Deferred.await(ready).pipe(Effect.andThen(update((current) => ({
        supervisionState: "ready", ...(current.lastErrorPhase === "supervision" ? { lastErrorPhase: null } : {}),
      })))));
      return yield* runGuidanceApplication(readers, store, t3, () => { Deferred.doneUnsafe(ready, Effect.void); });
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return update(() => ({ supervisionState: "degraded", lastErrorPhase: "supervision" })).pipe(
          Effect.andThen(logEvent("supervision_unavailable")), Effect.andThen(Effect.sleep("10 seconds")));
      }),
      Effect.forever,
    );
    yield* Effect.forkScoped(supervision);
  }

  const watch = Effect.gen(function* () {
    const cursor = yield* store.cursor("active");
    yield* t3.watch(cursor === 0 ? undefined : cursor, (item) => store.ingest(item).pipe(
      Effect.tap(() => update(() => ({ t3Connected: true }))),
    ));
  }).pipe(
    Effect.ensuring(update(() => ({ t3Connected: false }))),
    (effect) => guard(effect, "t3_stream"),
    Effect.forever,
  );

  return yield* watch;
});

// the read token, trimmed, as a Redacted value; a missing or unreadable file fails without its path or cause
const T3Token = Schema.RedactedFromValue(Schema.Trim);
const readT3Token = (path: string) => FileSystem.FileSystem.use((files) => files.readFileString(path)).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(T3Token)),
  Effect.mapError(() => new T3TokenUnavailable()),
);

const t3Client = Layer.unwrap(Effect.gen(function* () {
  const config = yield* SupervisorConfig;
  const token = yield* readT3Token(config.t3TokenFile);
  return makeT3Client({ baseUrl: config.t3Url, token: Redacted.value(token) });
}));

const catalog = Layer.unwrap(SupervisorConfig.useSync((config) => makeStore(config.dataDirectory)));

export type SupervisorServices = SupervisorConfig | SupervisorStatusRef | Store | T3Client | ThreadPolicy | SupervisorOwnership;

// the root services over the configuration, acquired in today's order: ownership, thread policy, the T3 client over the
// read token, then the catalog and the status; they release in reverse
export const SupervisorServicesLive = Layer.mergeAll(catalog, SupervisorStatusRef.layer).pipe(
  Layer.provideMerge(t3Client),
  Layer.provideMerge(ThreadPolicy.layer),
  Layer.provideMerge(SupervisorOwnership.layer),
);

// the server graph over the current ConfigProvider: the configuration, the node file system and the root services
export const SupervisorLive = SupervisorServicesLive.pipe(
  Layer.provideMerge(SupervisorConfig.layer),
  Layer.provide(NodeFileSystem.layer),
);

// the supervisor run over its services: the run scope (health listener and supervision, maintenance and watch fibers)
// closes before the services release, so no store closes under a running fiber (D-10)
export const supervise = <E, R>(services: Layer.Layer<SupervisorServices, E, R>) =>
  runSupervisor.pipe(Effect.scoped, Effect.provide(services));

// one classified line for a failed program; an interruption prints nothing
export const reportFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause) ? Effect.void : logEvent("supervisor_failed", { reason: failureReason(cause) });
