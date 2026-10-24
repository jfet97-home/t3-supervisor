import assert from "node:assert/strict";
import {request} from "node:http";
import {connect} from "node:net";
import {join} from "node:path";
import {it} from "@effect/vitest";
import {Clock, Console, Deferred, Effect, Exit, Fiber, Queue, SubscriptionRef} from "effect";
import {TestClock} from "effect/testing";
import {createStatus, supervise, type SupervisorStatus} from "../src/supervisor.js";
import {buildInfo} from "../src/version.js";
import {T3TransportError, type T3ClientShape, type T3EnvironmentDescriptor} from "../src/t3.js";
import type {ProjectInfo, SupervisorConfig} from "../src/types.js";
import {freePort} from "./support/g8-process.js";
import {onLiveClock} from "./support/g11-http.js";
import {dataDirectory} from "./support/g9-stores.js";
import {eventConsole, pinnableClock, rootServices, statusView} from "./support/g9-supervisor.js";

// it.live for the cases on a real health listener (loopback HTTP and tcp probes, real database files; their 3 s bounds
// are hang guards on the live clock); it.effect with TestClock for the retry timing cases. The run's structured events
// are read from the Console it writes through

const environment: T3EnvironmentDescriptor = {environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2};
const project: ProjectInfo = {id: "project", title: "Project", workspaceRoot: "/work/project"};
const projectItem = {stream: "active", item: {kind: "project.updated", sequence: 1, project}} as const;
const healthKeys = ["ok", "version", "revision", "readiness", "startedAt", "activation", "environmentId", "t3Connected", "storeState", "supervisionState", "heartbeat", "lastErrorPhase", "store"];

const config = (directory: string, healthPort: number): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: join(directory, "missing-token"),
  excludedThreadIds: [],
  healthPort,
});

const temporaryDirectory = dataDirectory("c1-supervisor-");

// the status service over a SubscriptionRef created at the test's current time, and its live view
const liveStatus = (settings: SupervisorConfig) => Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make(createStatus(settings, yield* Clock.currentTimeMillis));
  return {ref, status: statusView(ref)};
});

// the run on its services in the test scope (interrupted when the test ends), writing its events to `console` and, when
// one is given, reading the time from `clock`
const startReal = (settings: SupervisorConfig, ref: SubscriptionRef.SubscriptionRef<SupervisorStatus>, client: T3ClientShape,
  console: Console.Console, clock?: Clock.Clock) => {
  const run = supervise(rootServices(settings, ref, client)).pipe(Effect.provideService(Console.Console, console));
  return Effect.forkScoped(clock ? Effect.provideService(run, Clock.Clock, clock) : run);
};

const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;

// a wait for an in-process signal on a live-clock case, bounded on the live clock with the baseline's 3 s and label
const withDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>, milliseconds: number, label: string) =>
  Effect.timeoutOrElse(effect, {duration: milliseconds, orElse: () => Effect.die(new Error(`${label}: no outcome within ${milliseconds} ms`))});

// one request or connection probe of the loopback adapter (each bounded at 3 s on the live clock): a GET on its own connection
// (no keep-alive agent), so nothing outlives the response, and the error code of a fresh tcp connect, null when it was accepted
const liveBound = <A>(effect: Effect.Effect<A, Error>, label: string) => onLiveClock(effect.pipe(Effect.orDie,
  Effect.timeoutOrElse({duration: "3 seconds", orElse: () => Effect.die(new Error(`${label}: no outcome within 3000 ms`))})));
const get = (port: number, path: string) => liveBound(Effect.callback<{status: number; contentType: string | undefined; body: string}, Error>((resume) => {
  const outgoing = request({host: "127.0.0.1", port, path, method: "GET", agent: false}, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", (error) => resume(Effect.fail(error)));
    response.once("end", () => resume(Effect.succeed({status: response.statusCode ?? 0, contentType: response.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8")})));
  });
  outgoing.once("error", (error) => resume(Effect.fail(error)));
  outgoing.end();
  return Effect.sync(() => outgoing.destroy());
}), `GET ${path}`);
const connectFails = (port: number) => liveBound(Effect.callback<string | null, Error>((resume) => {
  const socket = connect({host: "127.0.0.1", port});
  socket.once("connect", () => {socket.destroy();resume(Effect.succeed(null));});
  socket.once("error", (error: NodeJS.ErrnoException) => resume(Effect.succeed(error.code ?? error.message)));
  return Effect.sync(() => socket.destroy());
}), `connect ${port}`);

// a test clock wait for an in-process signal, bounded on the live clock
const within = <A, E, R>(effect: Effect.Effect<A, E, R>) => TestClock.withLive(effect.pipe(Effect.timeout("3 seconds")));

it.live("CT-HEALTH-01: /health and /live answer over real HTTP with the exact status matrix, body keys and empty 404 bodies", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const port = yield* freePort;
  const settings = config(directory, port);
  const {ref, status} = yield* liveStatus(settings);
  const descriptorCalled = yield* Deferred.make<void>();
  const descriptorGate = yield* Deferred.make<void>();
  const watchCalled = yield* Deferred.make<void>();
  const watchGate = yield* Deferred.make<void>();
  const ingested = yield* Deferred.make<void>();
  const {console} = yield* eventConsole();
  const clock = yield* pinnableClock;
  const client: T3ClientShape = {
    descriptor: () => Deferred.succeed(descriptorCalled, undefined).pipe(
      Effect.andThen(Deferred.await(descriptorGate)), Effect.as(environment)),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => Deferred.succeed(watchCalled, undefined).pipe(
      Effect.andThen(Deferred.await(watchGate)),
      Effect.andThen(onItem(projectItem)),
      Effect.andThen(Deferred.succeed(ingested, undefined)),
      Effect.andThen(Effect.never)),
  };
  yield* startReal(settings, ref, client, console, clock.clock);
  // the descriptor is requested only after the health listener is up
  yield* withDeadline(Deferred.await(descriptorCalled), 3_000, "descriptor request");

  const starting = yield* get(port, "/health");
  assert.equal(starting.status, 503);
  assert.equal(starting.contentType, "application/json");
  const startingBody = parse(starting.body);
  assert.deepEqual(Object.keys(startingBody), healthKeys);
  assert.equal(startingBody.ok, false);
  assert.equal(startingBody.activation, null);
  assert.equal(startingBody.t3Connected, false);
  assert.equal(startingBody.supervisionState, "disabled");
  assert.deepEqual(Object.keys(startingBody.readiness as object), ["alive", "ready", "supervisionProgress"]);
  const live = yield* get(port, "/live");
  assert.equal(live.status, 200);
  assert.equal(live.contentType, "application/json");
  assert.deepEqual(Object.keys(parse(live.body)), healthKeys);
  assert.equal(parse(live.body).ok, true);
  for (const path of ["/health?x", "/other", "/live?x", "/health/", "/"]) {
    const missing = yield* get(port, path);
    assert.equal(missing.status, 404, path);
    assert.equal(missing.body, "", path);
    assert.equal(missing.contentType, undefined, path);
  }

  yield* Deferred.succeed(descriptorGate, undefined);
  yield* withDeadline(Deferred.await(watchCalled), 3_000, "watch start");
  const activated = yield* get(port, "/health");
  assert.equal(activated.status, 503);
  const activatedBody = parse(activated.body);
  assert.equal(activatedBody.ok, false);
  assert.equal(activatedBody.activation, status.activation);
  assert.equal(activatedBody.environmentId, "environment");
  assert.equal(activatedBody.t3Connected, false);
  assert.deepEqual(activatedBody.readiness, {alive: true, ready: false, supervisionProgress: true});

  yield* Deferred.succeed(watchGate, undefined);
  yield* withDeadline(Deferred.await(ingested), 3_000, "first item ingest");
  assert.equal(status.storeState, "ready");
  const ready = yield* get(port, "/health");
  assert.equal(ready.status, 200);
  assert.equal(ready.contentType, "application/json");
  const readyBody = parse(ready.body);
  assert.deepEqual(Object.keys(readyBody), healthKeys);
  assert.deepEqual(readyBody, JSON.parse(JSON.stringify({ok: true, version: buildInfo.version, revision: buildInfo.gitHead ?? null,
    readiness: {alive: true, ready: true, supervisionProgress: true}, ...status})));
  assert.equal(readyBody.t3Connected, true);
  assert.equal(readyBody.storeState, "ready");

  // liveness is evaluated per request: fresh strictly below 60000 ms after the heartbeat (the run's clock is pinned)
  const heartbeat = status.heartbeat;
  yield* Effect.gen(function* () {
    yield* clock.pin(heartbeat + 59_999);
    const fresh = yield* get(port, "/live");
    assert.equal(fresh.status, 200);
    assert.equal(parse(fresh.body).ok, true);
    assert.equal((yield* get(port, "/health")).status, 200);
    yield* clock.pin(heartbeat + 60_000);
    const stale = yield* get(port, "/live");
    assert.equal(stale.status, 503);
    assert.equal(stale.contentType, "application/json");
    assert.deepEqual(parse(stale.body).readiness, {alive: false, ready: false, supervisionProgress: true});
    assert.equal(parse(stale.body).ok, false);
    assert.equal((yield* get(port, "/health")).status, 503);
  }).pipe(Effect.ensuring(clock.pin(undefined)));
}), {timeout: 10_000});

it.live("CT-HEALTH-01: enabled supervision that is not ready keeps /health at 503 while /live stays 200", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const port = yield* freePort;
  const settings = {...config(directory, port), uiPort: 0, uiHost: "127.0.0.1"};
  const {ref, status} = yield* liveStatus(settings);
  const supervisionFailed = yield* Deferred.make<void>();
  const ingested = yield* Deferred.make<void>();
  const {console} = yield* eventConsole((event) => {
    if (event === "supervision_unavailable") Deferred.doneUnsafe(supervisionFailed, Exit.void);
  });
  const client: T3ClientShape = {
    descriptor: () => Effect.succeed(environment),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem(projectItem).pipe(
      Effect.andThen(Deferred.succeed(ingested, undefined)),
      Effect.andThen(Effect.never)),
  };
  yield* startReal(settings, ref, client, console);
  // the guidance application cannot read the missing token file, so supervision degrades
  yield* withDeadline(Effect.all([Deferred.await(supervisionFailed), Deferred.await(ingested)]), 3_000, "supervision failure and ingest");
  assert.equal(status.storeState, "ready");
  const health = yield* get(port, "/health");
  assert.equal(health.status, 503);
  const body = parse(health.body);
  assert.deepEqual(Object.keys(body), healthKeys);
  assert.equal(body.ok, false);
  assert.equal(body.t3Connected, true);
  assert.equal(body.environmentId, "environment");
  assert.equal(body.supervisionState, "degraded");
  assert.equal(body.lastErrorPhase, "supervision");
  assert.deepEqual(body.readiness, {alive: true, ready: false, supervisionProgress: false});
  assert.equal((yield* get(port, "/live")).status, 200);
}), {timeout: 10_000});

it.effect("CT-MAIN-04: a descriptor failure sets t3_authentication and retries exactly every 10 s", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const settings = config(directory, 0);
  const {ref, status} = yield* liveStatus(settings);
  const {console, events} = yield* eventConsole();
  yield* Effect.gen(function* () {
    const descriptorCalls = yield* Queue.unbounded<number>();
    const watchCalls = yield* Queue.unbounded<number>();
    let attempts = 0;
    const client: T3ClientShape = {
      descriptor: () => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        attempts += 1;
        yield* Queue.offer(descriptorCalls, now);
        if (attempts <= 2) return yield* Effect.fail(new T3TransportError("descriptor unavailable"));
        return environment;
      }),
      projection: () => Effect.fail(new T3TransportError("No projection is expected")),
      watch: () => Clock.currentTimeMillis.pipe(Effect.flatMap(now => Queue.offer(watchCalls, now)), Effect.andThen(Effect.never)),
    };
    const fiber = yield* startReal(settings, ref, client, console);
    assert.equal(yield* within(Queue.take(descriptorCalls)), 0);
    assert.equal(status.lastErrorPhase, "t3_authentication");
    assert.equal(status.activation, null);
    yield* TestClock.adjust(9_999);
    assert.equal(yield* Queue.size(descriptorCalls), 0);
    yield* TestClock.adjust(1);
    assert.equal(yield* within(Queue.take(descriptorCalls)), 10_000);
    assert.equal(status.lastErrorPhase, "t3_authentication");
    yield* TestClock.adjust(9_999);
    assert.equal(yield* Queue.size(descriptorCalls), 0);
    yield* TestClock.adjust(1);
    assert.equal(yield* within(Queue.take(descriptorCalls)), 20_000);
    assert.equal(yield* within(Queue.take(watchCalls)), 20_000);
    assert.equal(status.environmentId, "environment");
    assert.ok(status.activation);
    assert.equal(attempts, 3);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped);
  // descriptor retries are silent; only the start is logged
  assert.deepEqual(events.map(event => event.event), ["supervisor_started"]);
}), {timeout: 10_000});

it.effect("CT-MAIN-04: a supervision failure degrades and restarts the guidance application exactly 10 s later", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const settings = {...config(directory, 0), uiPort: 0, uiHost: "127.0.0.1"};
  const {ref, status} = yield* liveStatus(settings);
  yield* Effect.gen(function* () {
    const failures = yield* Queue.unbounded<string>();
    const descriptorCalls = yield* Queue.unbounded<number>();
    const {console, events} = yield* eventConsole((event) => {
      if (event === "supervision_unavailable") Queue.offerUnsafe(failures, event);
    });
    const client: T3ClientShape = {
      descriptor: () => Clock.currentTimeMillis.pipe(Effect.flatMap(now => Queue.offer(descriptorCalls, now)), Effect.as(environment)),
      projection: () => Effect.fail(new T3TransportError("No projection is expected")),
      watch: () => Effect.never,
    };
    const fiber = yield* startReal(settings, ref, client, console);
    // the root activation and the first guidance application each read the descriptor at 0
    assert.equal(yield* within(Queue.take(descriptorCalls)), 0);
    assert.equal(yield* within(Queue.take(descriptorCalls)), 0);
    yield* within(Queue.take(failures));
    assert.equal(status.supervisionState, "degraded");
    assert.equal(status.lastErrorPhase, "supervision");
    yield* TestClock.adjust(9_999);
    assert.equal(yield* Queue.size(descriptorCalls), 0);
    assert.equal(yield* Queue.size(failures), 0);
    yield* TestClock.adjust(1);
    assert.equal(yield* within(Queue.take(descriptorCalls)), 10_000);
    yield* within(Queue.take(failures));
    assert.equal(status.supervisionState, "degraded");
    assert.equal(status.lastErrorPhase, "supervision");
    yield* Fiber.interrupt(fiber);
    assert.deepEqual(events.map(event => event.event), ["supervisor_started", "supervision_unavailable", "supervision_unavailable"]);
  }).pipe(Effect.scoped);
}), {timeout: 10_000});

it.effect("CT-MAIN-04: a watch failure clears t3Connected and restarts the watch exactly 10 s later", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const settings = config(directory, 0);
  const {ref, status} = yield* liveStatus(settings);
  yield* Effect.gen(function* () {
    const deferred = yield* Queue.unbounded<Record<string, unknown>>();
    const watchCalls = yield* Queue.unbounded<number>();
    const {console, events} = yield* eventConsole((event, fields) => {
      if (event === "operation_deferred") Queue.offerUnsafe(deferred, fields);
    });
    let connectedBeforeFailure = false;
    let attempts = 0;
    const client: T3ClientShape = {
      descriptor: () => Effect.succeed(environment),
      projection: () => Effect.fail(new T3TransportError("No projection is expected")),
      watch: (_cursor, onItem) => Effect.gen(function* () {
        attempts += 1;
        yield* Queue.offer(watchCalls, yield* Clock.currentTimeMillis);
        if (attempts > 1) return yield* Effect.never;
        yield* onItem(projectItem);
        connectedBeforeFailure = status.t3Connected;
        return yield* Effect.fail(new T3TransportError("stream dropped"));
      }),
    };
    const fiber = yield* startReal(settings, ref, client, console);
    assert.equal(yield* within(Queue.take(watchCalls)), 0);
    const failure = yield* within(Queue.take(deferred));
    assert.equal(failure.phase, "t3_stream");
    assert.equal(connectedBeforeFailure, true);
    assert.equal(status.t3Connected, false);
    assert.equal(status.lastErrorPhase, "t3_stream");
    yield* TestClock.adjust(9_999);
    assert.equal(yield* Queue.size(watchCalls), 0);
    yield* TestClock.adjust(1);
    assert.equal(yield* within(Queue.take(watchCalls)), 10_000);
    assert.equal(status.t3Connected, false);
    yield* Fiber.interrupt(fiber);
    assert.deepEqual(events.map(event => event.event), ["supervisor_started", "operation_deferred"]);
  }).pipe(Effect.scoped);
}), {timeout: 10_000});

it.live("CT-MAIN-05: interrupting runSupervisor closes the health listener and logs no operation_deferred", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const port = yield* freePort;
  const settings = config(directory, port);
  const {ref, status} = yield* liveStatus(settings);
  const watching = yield* Deferred.make<void>();
  const {console, events} = yield* eventConsole();
  const client: T3ClientShape = {
    descriptor: () => Effect.succeed(environment),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem(projectItem).pipe(
      Effect.andThen(Deferred.succeed(watching, undefined)),
      Effect.andThen(Effect.never)),
  };
  const fiber = yield* startReal(settings, ref, client, console);
  yield* withDeadline(Deferred.await(watching), 3_000, "watch start");
  assert.equal(status.t3Connected, true);
  assert.equal((yield* get(port, "/live")).status, 200);

  yield* withDeadline(Fiber.interrupt(fiber), 3_000, "interruption");
  assert.equal(yield* connectFails(port), "ECONNREFUSED");
  assert.equal(status.t3Connected, false);
  assert.deepEqual(events.map(event => event.event), ["supervisor_started"]);
}), {timeout: 10_000});

it.live("CT-MAIN-05: interruption inside the deferred-retry sleep logs no further operation_deferred", () => Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const port = yield* freePort;
  const settings = config(directory, port);
  const {ref, status} = yield* liveStatus(settings);
  const deferredLogged = yield* Deferred.make<void>();
  const {console, events} = yield* eventConsole((event) => {
    if (event === "operation_deferred") Deferred.doneUnsafe(deferredLogged, Exit.void);
  });
  const client: T3ClientShape = {
    descriptor: () => Effect.succeed(environment),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: () => Effect.fail(new T3TransportError("stream dropped")),
  };
  const fiber = yield* startReal(settings, ref, client, console);
  yield* withDeadline(Deferred.await(deferredLogged), 3_000, "first deferral");
  assert.equal(status.lastErrorPhase, "t3_stream");

  yield* withDeadline(Fiber.interrupt(fiber), 3_000, "interruption");
  assert.equal(yield* connectFails(port), "ECONNREFUSED");
  assert.deepEqual(events.map(event => [event.event, event.phase]), [["supervisor_started", undefined], ["operation_deferred", "t3_stream"]]);
}), {timeout: 10_000});
