import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Clock, Effect, Fiber, Layer, Queue, SubscriptionRef, type Scope} from "effect";
import {TestClock} from "effect/testing";
import {it, vi, type TestContext} from "vitest";
import {SupervisorConfig as Configuration} from "../src/config.js";
import {SupervisorOwnership} from "../src/project-supervisor-store.js";
import {makeStore} from "../src/store.js";
import {createStatus, NativeTransportLive, supervise, SupervisorStatusRef, type SupervisorStatus} from "../src/supervisor.js";
import {ThreadPolicy} from "../src/thread-policy.js";
import {T3Client, T3TransportError, type T3ClientShape, type T3EnvironmentDescriptor} from "../src/t3.js";
import type {ProjectInfo, SupervisorConfig} from "../src/types.js";
import {after, mockMethod} from "./support/node-test.js";
import {connectionError, freePort, httpGet, withDeadline} from "./support/c1-loopback.js";

const environment: T3EnvironmentDescriptor = {environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2};
const project: ProjectInfo = {id: "project", title: "Project", workspaceRoot: "/work/project"};
const projectItem = {stream: "active", item: {kind: "project.updated", sequence: 1, project}} as const;
const healthKeys = ["ok", "readiness", "startedAt", "activation", "environmentId", "t3Connected", "storeState", "supervisionState", "heartbeat", "lastErrorPhase", "store"];

const config = (directory: string, healthPort: number): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: join(directory, "missing-token"),
  excludedThreadIds: [],
  healthPort,
});

const temporaryDirectory = async (t: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "c1-supervisor-"));
  after(t, () => rm(directory, {recursive: true, force: true}));
  return directory;
};

// structured supervisor log lines, in order; other console output is kept out of the report
const captureEvents = (t: TestContext, onEvent: (event: string, fields: Record<string, unknown>) => void = () => {}) => {
  const events: Array<Record<string, unknown>> = [];
  mockMethod(t, console, "log", (line: unknown) => {
    if (typeof line !== "string") return;
    let parsed: unknown;
    try {parsed = JSON.parse(line);} catch {return;}
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as {event?: unknown}).event !== "string") return;
    const fields = parsed as Record<string, unknown>;
    events.push(fields);
    onEvent(fields.event as string, fields);
  });
  return events;
};

// the status service over a SubscriptionRef, seen through a live view so the assertions read the current status as they
// read the baseline status object
const statusRefs = new WeakMap<SupervisorStatus, SubscriptionRef.SubscriptionRef<SupervisorStatus>>();
const liveStatus = (settings: SupervisorConfig): SupervisorStatus => {
  const ref = Effect.runSync(SubscriptionRef.make(createStatus(settings, Date.now())));
  const view = Object.defineProperties({}, Object.fromEntries(Object.keys(SubscriptionRef.getUnsafe(ref)).map((key) =>
    [key, {enumerable: true, get: () => SubscriptionRef.getUnsafe(ref)[key as keyof SupervisorStatus]}]))) as SupervisorStatus;
  statusRefs.set(view, ref);
  return view;
};

// the services of the run: the catalog, the fake T3 client, the status and the root thread-policy and ownership services
const layers = (settings: SupervisorConfig, status: SupervisorStatus, client: T3ClientShape) => Layer.mergeAll(
  makeStore(settings.dataDirectory), Layer.succeed(T3Client, client), Layer.succeed(SupervisorStatusRef, statusRefs.get(status)!),
  ThreadPolicy.layer, SupervisorOwnership.layer, NativeTransportLive,
).pipe(Layer.provideMerge(Layer.succeed(Configuration, settings)));

const startReal = (t: TestContext, settings: SupervisorConfig, status: SupervisorStatus, client: T3ClientShape, settle: () => void) => {
  const fiber = Effect.runFork(supervise(layers(settings, status, client)));
  after(t, async () => {
    await Effect.runPromise(Fiber.interrupt(fiber));
    settle();
  });
  return fiber;
};

const parse = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;

// a test clock wait for an in-process signal, bounded on the live clock
const within = <A, E, R>(effect: Effect.Effect<A, E, R>) => TestClock.withLive(effect.pipe(Effect.timeout("3 seconds")));

const runWithTestClock = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestClock.layer())));

it("CT-HEALTH-01: /health and /live answer over real HTTP with the exact status matrix, body keys and empty 404 bodies", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const port = await freePort();
  const settings = config(directory, port);
  const status = liveStatus(settings);
  const descriptorCalled = Promise.withResolvers<void>();
  const descriptorGate = Promise.withResolvers<void>();
  const watchCalled = Promise.withResolvers<void>();
  const watchGate = Promise.withResolvers<void>();
  const ingested = Promise.withResolvers<void>();
  captureEvents(t);
  const client: T3ClientShape = {
    descriptor: () => Effect.sync(() => descriptorCalled.resolve()).pipe(
      Effect.andThen(Effect.promise(() => descriptorGate.promise)), Effect.as(environment)),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => Effect.sync(() => watchCalled.resolve()).pipe(
      Effect.andThen(Effect.promise(() => watchGate.promise)),
      Effect.andThen(onItem(projectItem)),
      Effect.andThen(Effect.sync(() => ingested.resolve())),
      Effect.andThen(Effect.never)),
  };
  startReal(t, settings, status, client, () => {
    for (const gate of [descriptorCalled, descriptorGate, watchCalled, watchGate, ingested]) gate.resolve();
  });
  // the descriptor is requested only after the health listener is up
  await withDeadline(descriptorCalled.promise, 3_000, "descriptor request");

  const starting = await httpGet(port, "/health");
  assert.equal(starting.status, 503);
  assert.equal(starting.contentType, "application/json");
  const startingBody = parse(starting.body);
  assert.deepEqual(Object.keys(startingBody), healthKeys);
  assert.equal(startingBody.ok, false);
  assert.equal(startingBody.activation, null);
  assert.equal(startingBody.t3Connected, false);
  assert.equal(startingBody.supervisionState, "disabled");
  assert.deepEqual(Object.keys(startingBody.readiness as object), ["alive", "ready", "supervisionProgress"]);
  const live = await httpGet(port, "/live");
  assert.equal(live.status, 200);
  assert.equal(live.contentType, "application/json");
  assert.deepEqual(Object.keys(parse(live.body)), healthKeys);
  assert.equal(parse(live.body).ok, true);
  for (const path of ["/health?x", "/other", "/live?x", "/health/", "/"]) {
    const missing = await httpGet(port, path);
    assert.equal(missing.status, 404, path);
    assert.equal(missing.body, "", path);
    assert.equal(missing.contentType, undefined, path);
  }

  descriptorGate.resolve();
  await withDeadline(watchCalled.promise, 3_000, "watch start");
  const activated = await httpGet(port, "/health");
  assert.equal(activated.status, 503);
  const activatedBody = parse(activated.body);
  assert.equal(activatedBody.ok, false);
  assert.equal(activatedBody.activation, status.activation);
  assert.equal(activatedBody.environmentId, "environment");
  assert.equal(activatedBody.t3Connected, false);
  assert.deepEqual(activatedBody.readiness, {alive: true, ready: false, supervisionProgress: true});

  watchGate.resolve();
  await withDeadline(ingested.promise, 3_000, "first item ingest");
  assert.equal(status.storeState, "ready");
  const ready = await httpGet(port, "/health");
  assert.equal(ready.status, 200);
  assert.equal(ready.contentType, "application/json");
  const readyBody = parse(ready.body);
  assert.deepEqual(Object.keys(readyBody), healthKeys);
  assert.deepEqual(readyBody, JSON.parse(JSON.stringify({ok: true, readiness: {alive: true, ready: true, supervisionProgress: true}, ...status})));
  assert.equal(readyBody.t3Connected, true);
  assert.equal(readyBody.storeState, "ready");

  // liveness is evaluated per request: fresh strictly below 60000 ms after the heartbeat
  const heartbeat = status.heartbeat;
  const clock = vi.spyOn(Date, "now");
  try {
    clock.mockReturnValue(heartbeat + 59_999);
    const fresh = await httpGet(port, "/live");
    assert.equal(fresh.status, 200);
    assert.equal(parse(fresh.body).ok, true);
    assert.equal((await httpGet(port, "/health")).status, 200);
    clock.mockReturnValue(heartbeat + 60_000);
    const stale = await httpGet(port, "/live");
    assert.equal(stale.status, 503);
    assert.equal(stale.contentType, "application/json");
    assert.deepEqual(parse(stale.body).readiness, {alive: false, ready: false, supervisionProgress: true});
    assert.equal(parse(stale.body).ok, false);
    assert.equal((await httpGet(port, "/health")).status, 503);
  } finally {
    clock.mockRestore();
  }
});

it("CT-HEALTH-01: enabled supervision that is not ready keeps /health at 503 while /live stays 200", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const port = await freePort();
  const settings = {...config(directory, port), uiPort: 0, uiHost: "127.0.0.1"};
  const status = liveStatus(settings);
  const supervisionFailed = Promise.withResolvers<void>();
  const ingested = Promise.withResolvers<void>();
  captureEvents(t, (event) => {
    if (event === "supervision_unavailable") supervisionFailed.resolve();
  });
  const client: T3ClientShape = {
    descriptor: () => Effect.succeed(environment),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem(projectItem).pipe(
      Effect.andThen(Effect.sync(() => ingested.resolve())),
      Effect.andThen(Effect.never)),
  };
  startReal(t, settings, status, client, () => {
    supervisionFailed.resolve();
    ingested.resolve();
  });
  // the guidance application cannot read the missing token file, so supervision degrades
  await withDeadline(Promise.all([supervisionFailed.promise, ingested.promise]), 3_000, "supervision failure and ingest");
  assert.equal(status.storeState, "ready");
  const health = await httpGet(port, "/health");
  assert.equal(health.status, 503);
  const body = parse(health.body);
  assert.deepEqual(Object.keys(body), healthKeys);
  assert.equal(body.ok, false);
  assert.equal(body.t3Connected, true);
  assert.equal(body.environmentId, "environment");
  assert.equal(body.supervisionState, "degraded");
  assert.equal(body.lastErrorPhase, "supervision");
  assert.deepEqual(body.readiness, {alive: true, ready: false, supervisionProgress: false});
  assert.equal((await httpGet(port, "/live")).status, 200);
});

it("CT-MAIN-04: a descriptor failure sets t3_authentication and retries exactly every 10 s", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = config(directory, 0);
  const status = liveStatus(settings);
  const events = captureEvents(t);
  await runWithTestClock(Effect.gen(function* () {
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
    const fiber = yield* Effect.forkChild(supervise(layers(settings, status, client)));
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
  }));
  // descriptor retries are silent; only the start is logged
  assert.deepEqual(events.map(event => event.event), ["supervisor_started"]);
});

it("CT-MAIN-04: a supervision failure degrades and restarts the guidance application exactly 10 s later", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = {...config(directory, 0), uiPort: 0, uiHost: "127.0.0.1"};
  const status = liveStatus(settings);
  await runWithTestClock(Effect.gen(function* () {
    const failures = yield* Queue.unbounded<string>();
    const descriptorCalls = yield* Queue.unbounded<number>();
    const events = captureEvents(t, (event) => {
      if (event === "supervision_unavailable") Queue.offerUnsafe(failures, event);
    });
    const client: T3ClientShape = {
      descriptor: () => Clock.currentTimeMillis.pipe(Effect.flatMap(now => Queue.offer(descriptorCalls, now)), Effect.as(environment)),
      projection: () => Effect.fail(new T3TransportError("No projection is expected")),
      watch: () => Effect.never,
    };
    const fiber = yield* Effect.forkChild(supervise(layers(settings, status, client)));
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
  }));
});

it("CT-MAIN-04: a watch failure clears t3Connected and restarts the watch exactly 10 s later", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const settings = config(directory, 0);
  const status = liveStatus(settings);
  await runWithTestClock(Effect.gen(function* () {
    const deferred = yield* Queue.unbounded<Record<string, unknown>>();
    const watchCalls = yield* Queue.unbounded<number>();
    const events = captureEvents(t, (event, fields) => {
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
    const fiber = yield* Effect.forkChild(supervise(layers(settings, status, client)));
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
  }));
});

it("CT-MAIN-05: interrupting runSupervisor closes the health listener and logs no operation_deferred", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const port = await freePort();
  const settings = config(directory, port);
  const status = liveStatus(settings);
  const watching = Promise.withResolvers<void>();
  const events = captureEvents(t);
  const client: T3ClientShape = {
    descriptor: () => Effect.succeed(environment),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem(projectItem).pipe(
      Effect.andThen(Effect.sync(() => watching.resolve())),
      Effect.andThen(Effect.never)),
  };
  const fiber = startReal(t, settings, status, client, () => watching.resolve());
  await withDeadline(watching.promise, 3_000, "watch start");
  assert.equal(status.t3Connected, true);
  assert.equal((await httpGet(port, "/live")).status, 200);

  await withDeadline(Effect.runPromise(Fiber.interrupt(fiber)), 3_000, "interruption");
  assert.equal(await connectionError(port), "ECONNREFUSED");
  assert.equal(status.t3Connected, false);
  assert.deepEqual(events.map(event => event.event), ["supervisor_started"]);
});

it("CT-MAIN-05: interruption inside the deferred-retry sleep logs no further operation_deferred", {timeout: 10_000}, async (t) => {
  const directory = await temporaryDirectory(t);
  const port = await freePort();
  const settings = config(directory, port);
  const status = liveStatus(settings);
  const deferredLogged = Promise.withResolvers<void>();
  const events = captureEvents(t, (event) => {
    if (event === "operation_deferred") deferredLogged.resolve();
  });
  const client: T3ClientShape = {
    descriptor: () => Effect.succeed(environment),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: () => Effect.fail(new T3TransportError("stream dropped")),
  };
  const fiber = startReal(t, settings, status, client, () => deferredLogged.resolve());
  await withDeadline(deferredLogged.promise, 3_000, "first deferral");
  assert.equal(status.lastErrorPhase, "t3_stream");

  await withDeadline(Effect.runPromise(Fiber.interrupt(fiber)), 3_000, "interruption");
  assert.equal(await connectionError(port), "ECONNREFUSED");
  assert.deepEqual(events.map(event => [event.event, event.phase]), [["supervisor_started", undefined], ["operation_deferred", "t3_stream"]]);
});
