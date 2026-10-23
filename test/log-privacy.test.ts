import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { inspect } from "node:util";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Clock, Effect, Exit, Fiber, FileSystem, Layer, Logger, Stream, SubscriptionRef, Tracer } from "effect";
import type { TestContext } from "vitest";
import { SupervisorConfig as Configuration } from "../src/config.js";
import { policyDbLayer } from "../src/db.js";
import { NativeEnvelope } from "../src/native-envelope.js";
import { SupervisorOwnership } from "../src/project-supervisor-store.js";
import { forgeDashboardToken, ServiceAuth } from "../src/service-auth.js";
import { makeStore, type Store } from "../src/store.js";
import { NativeRpc, SupervisorRpcError } from "../src/supervisor-native.js";
import { createStatus, NativeTransportLive, readiness, supervise, SupervisorStatusRef, type SupervisorStatus } from "../src/supervisor.js";
import { makeT3Client, T3Client, T3TransportError, type T3ClientShape } from "../src/t3.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import type { SupervisorConfig } from "../src/types.js";
import { startFakeT3, untilTraffic, type FakeT3Options } from "./support/cli-fake-t3.js";
import { fingerprint, leakedSecrets } from "./support/cli-process.js";
import { cancelAfter, onLiveClock } from "./support/g11-http.js";
import { temporaryDirectory } from "./support/g11-stores.js";
import { mockMethod } from "./support/node-test.js";

// baseline log privacy: secrets injected into native, helper and auth failures, observed at every baseline log/span seam.
// it.live: the supervision runs talk to a loopback fake T3 (the cli suites' peer) over real sockets and keep their stores in
// database files, and the auth cases read and write the access files

interface Secrets {
  readonly token: string;
  readonly nativeBody: string;
  readonly webhookPath: string;
  readonly webhookUrl: string;
  readonly all: ReadonlyArray<string>;
}

const makeSecrets = (): Secrets => {
  const token = randomBytes(32).toString("base64url");
  const nativeBody = `native-provider-error-body-${randomBytes(12).toString("hex")}`;
  const webhookPath = `/api/hooks/supervisor-helper-${randomBytes(8).toString("hex")}/${randomBytes(24).toString("base64url")}`;
  const webhookUrl = `http://127.0.0.1:3773${webhookPath}`;
  return { token, nativeBody, webhookPath, webhookUrl, all: [token, nativeBody, webhookPath, webhookUrl] };
};

// a native error body as T3 would return it, carrying all three secrets
const nativeFailure = (secrets: Secrets) => ({
  _tag: "NativeProviderError",
  message: `provider rejected the request: ${secrets.nativeBody}`,
  detail: { authorization: `Bearer ${secrets.token}`, webhook: secrets.webhookUrl },
});

interface Observation {
  // every console line written by the code under test
  readonly console: string[];
  // every Effect log record, rendered as a JSON logger would emit it (including any cause)
  readonly effectLogs: string[];
  // every span the code under test created, rendered as an exporter would see it
  readonly spans: Tracer.NativeSpan[];
  until(predicate: (lines: ReadonlyArray<string>) => boolean, timeoutMs: number, label: string): Effect.Effect<void>;
}

// the console is the process's own: the code under test writes some lines through Effect's Console and some through
// console directly, so the observation replaces the global console methods (restored when the test finishes). A wait for a
// line removes its waiter when it ends, and its bound is a live-clock sleep that ends with it
const observe = (t: TestContext): Observation => {
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  const write = (...args: unknown[]) => {
    lines.push(args.map((value) => typeof value === "string" ? value : inspect(value, { depth: 20 })).join(" "));
    for (const waiter of waiters) waiter();
  };
  for (const method of ["log", "error", "warn", "info", "debug"] as const) mockMethod(t, console, method, write);
  return {
    console: lines,
    effectLogs: [],
    spans: [],
    until: (predicate, timeoutMs, label) => Effect.callback<void>((resume) => {
      const check = () => {
        if (!predicate(lines)) return;
        waiters.delete(check);
        resume(Effect.void);
      };
      waiters.add(check);
      check();
      return Effect.sync(() => waiters.delete(check));
    }).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.die(new Error(`no ${label} within ${timeoutMs} ms`)) }), onLiveClock),
  };
};

// the recording logger replaces the default loggers; the recording tracer replaces the native tracer
const instrumented = <A, E>(effect: Effect.Effect<A, E>, observation: Observation): Effect.Effect<A, E> => {
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      observation.spans.push(span);
      return span;
    },
  });
  const logger = Logger.make((options) => { observation.effectLogs.push(Logger.formatJson.log(options)); });
  return effect.pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.provide(Logger.layer([logger])));
};

const renderSpans = (spans: ReadonlyArray<Tracer.NativeSpan>): string[] => spans.map((span) => inspect({
  name: span.name,
  attributes: [...span.attributes],
  events: span.events,
  status: span.status._tag === "Ended" && Exit.isFailure(span.status.exit) ? Cause.pretty(span.status.exit.cause) : span.status._tag,
}, { depth: 20 }));

// supervisor log lines without their timestamp
const supervisorEvents = (lines: ReadonlyArray<string>) => lines.map((line) => {
  const fields = JSON.parse(line) as Record<string, unknown>;
  assert.equal(typeof fields.time, "string");
  delete fields.time;
  return fields;
});

const config = (dataDirectory: string, uiPort?: number): SupervisorConfig => ({
  dataDirectory, t3Url: "http://127.0.0.1:9", t3TokenFile: join(dataDirectory, "absent-token"), excludedThreadIds: [], healthPort: 0,
  ...(uiPort === undefined ? {} : { uiPort, uiHost: "127.0.0.1" }),
});

// the status service of a run, its SubscriptionRef created as the root creates it
const liveStatus = (settings: SupervisorConfig) => Effect.flatMap(Clock.currentTimeMillis, (now) => SubscriptionRef.make(createStatus(settings, now)));

// the services of the run: the given catalog and T3 client, the status and the root thread-policy (on its own client of the
// data directory) and ownership services
const services = (settings: SupervisorConfig, status: SubscriptionRef.SubscriptionRef<SupervisorStatus>, base: Layer.Layer<Store | T3Client, unknown>) => Layer.mergeAll(
  base, Layer.succeed(SupervisorStatusRef, status), ThreadPolicyStore.layer.pipe(Layer.provide(policyDbLayer(settings.dataDirectory))), SupervisorOwnership.layer,
  NativeTransportLive,
).pipe(Layer.provideMerge(Layer.succeed(Configuration, settings)), Layer.provideMerge(NodeFileSystem.layer));

// the /health body the current status would serve at the given time
const healthBody = (status: SubscriptionRef.SubscriptionRef<SupervisorStatus>, settings: SupervisorConfig) => Effect.gen(function* () {
  const current = yield* SubscriptionRef.get(status);
  return JSON.stringify({ ok: false, readiness: readiness(current, settings, yield* Clock.currentTimeMillis), ...current });
});

// the first status that holds the condition, within the deadline
const until = (status: SubscriptionRef.SubscriptionRef<SupervisorStatus>, condition: (current: SupervisorStatus) => boolean, timeoutMs: number, label: string) =>
  SubscriptionRef.changes(status).pipe(Stream.filter(condition), Stream.runHead,
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.die(new Error(`${label} not reached within ${timeoutMs} ms`)) }), onLiveClock);

// the cli suites' loopback fake T3, closed with the test scope; its traffic waits are untilTraffic, which an interruption ends
const fakeT3 = (options: FakeT3Options) => Effect.acquireRelease(Effect.promise(() => startFakeT3(options)), (fake) => Effect.promise(() => fake.close()));

// a case that expects a failure; a success fails the case by name
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>, unexpected: string) =>
  Effect.matchEffect(effect, { onSuccess: () => Effect.sync(() => assert.fail(unexpected)), onFailure: Effect.succeed });

const assertNoLeak = (label: string, outputs: ReadonlyArray<string>, secrets: Secrets) => {
  // failures name only fingerprints of the leaked values
  assert.deepEqual(leakedSecrets(outputs.join("\n"), secrets.all), [], `${label} leaks ${secrets.all.map(fingerprint).join(", ")}`);
};

it.live("CT-REDACT-01: native transport failures carrying a token, a native error body and a webhook URL leave only phase classifications in logs, status and spans",
  (t) => Effect.gen(function* () {
    const secrets = makeSecrets();
    const observation = observe(t);

    // descriptor answered with a 500 whose body carries the secrets: the retry records only the phase
    const refusing = yield* fakeT3({ token: secrets.token, descriptor: "failing", failure: nativeFailure(secrets) });
    const refusedDirectory = yield* temporaryDirectory("log-privacy-descriptor-");
    const refusedConfig = config(refusedDirectory);
    const refusedStatus = yield* liveStatus(refusedConfig);
    const refused = yield* Effect.forkChild(instrumented(supervise(services(refusedConfig, refusedStatus,
      Layer.mergeAll(makeStore(refusedDirectory), makeT3Client({ baseUrl: refusing.baseUrl, token: secrets.token })))), observation));
    yield* Effect.gen(function* () {
      yield* untilTraffic(refusing, (requests) => requests.http.length > 0, 5_000, "a descriptor request");
      yield* until(refusedStatus, (status) => status.lastErrorPhase === "t3_authentication", 5_000, "the descriptor failure phase");
    }).pipe(Effect.ensuring(Fiber.interrupt(refused)));
    assertNoLeak("descriptor status", [yield* healthBody(refusedStatus, refusedConfig)], secrets);

    // shell subscriptions answered with an Exit failure carrying the secrets: the guard logs the phase only
    const failing = yield* fakeT3({ token: secrets.token, failure: nativeFailure(secrets), failSubscriptions: true });
    const watchDirectory = yield* temporaryDirectory("log-privacy-watch-");
    const watchConfig = config(watchDirectory);
    const watchStatus = yield* liveStatus(watchConfig);
    const watching = yield* Effect.forkChild(instrumented(supervise(services(watchConfig, watchStatus,
      Layer.mergeAll(makeStore(watchDirectory), makeT3Client({ baseUrl: failing.baseUrl, token: secrets.token })))), observation));
    yield* observation.until((lines) => lines.some((line) => line.includes("operation_deferred")), 5_000, "operation_deferred line").pipe(
      Effect.ensuring(Fiber.interrupt(watching)));
    assert.equal((yield* SubscriptionRef.get(watchStatus)).lastErrorPhase, "t3_stream");
    assert.deepEqual(failing.traffic.requests, ["orchestration.subscribeShell", "orchestration.subscribeArchivedShell"]);

    assertNoLeak("console", observation.console, secrets);
    assertNoLeak("effect logs", observation.effectLogs, secrets);
    assertNoLeak("spans", renderSpans(observation.spans), secrets);
    assertNoLeak("watch status", [yield* healthBody(watchStatus, watchConfig)], secrets);
    // the baseline logs exactly these classifications, writes no Effect log record and creates no span on these paths
    assert.deepEqual(supervisorEvents(observation.console), [
      { event: "supervisor_started" },
      { event: "supervisor_started" },
      { event: "operation_deferred", phase: "t3_stream" },
    ]);
    assert.deepEqual(observation.effectLogs, []);
    assert.deepEqual(renderSpans(observation.spans), []);
  }), { timeout: 10_000 });

it.live("CT-REDACT-01: nested causes carrying a token, a native error body and a webhook URL reach the logger only as phase classifications",
  (t) => Effect.gen(function* () {
    const secrets = makeSecrets();
    const observation = observe(t);
    const directory = yield* temporaryDirectory("log-privacy-nested-");
    const nested = (): T3TransportError => {
      const error = new T3TransportError("T3 environment descriptor returned HTTP 500", 500);
      Object.assign(error, { cause: new Error(`upstream ${secrets.nativeBody}`, { cause: { authorization: `Bearer ${secrets.token}`, webhook: secrets.webhookUrl } }) });
      return error;
    };
    let descriptors = 0;
    // the first descriptor activates the catalog; the supervision start then fails, and the watch dies with a nested defect
    const client: T3ClientShape = {
      descriptor: () => Effect.suspend(() => {
        descriptors += 1;
        return descriptors === 1
          ? Effect.succeed({ environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2 as const })
          : Effect.fail(nested());
      }),
      projection: () => Effect.fail(nested()),
      watch: () => Effect.die(new Error(`subscription defect ${secrets.nativeBody}`,
        { cause: new Error(`webhook ${secrets.webhookUrl} refused Bearer ${secrets.token}`) })),
    };
    const settings = config(directory, 0);
    const status = yield* liveStatus(settings);
    const fiber = yield* Effect.forkChild(instrumented(supervise(services(settings, status,
      Layer.mergeAll(makeStore(directory), Layer.succeed(T3Client, client)))), observation));
    yield* observation.until((lines) => lines.some((line) => line.includes("supervision_unavailable")) &&
      lines.some((line) => line.includes("operation_deferred")), 5_000, "supervision and watch failure lines").pipe(Effect.ensuring(Fiber.interrupt(fiber)));
    assert.equal((yield* SubscriptionRef.get(status)).supervisionState, "degraded");
    assertNoLeak("console", observation.console, secrets);
    assertNoLeak("effect logs", observation.effectLogs, secrets);
    assertNoLeak("spans", renderSpans(observation.spans), secrets);
    assertNoLeak("status", [yield* healthBody(status, settings)], secrets);
    const sortedEvents = supervisorEvents(observation.console).map((fields) => JSON.stringify(fields)).sort();
    assert.deepEqual(sortedEvents, [
      JSON.stringify({ event: "operation_deferred", phase: "t3_stream" }),
      JSON.stringify({ event: "supervision_unavailable" }),
      JSON.stringify({ event: "supervisor_started" }),
    ]);
    assert.deepEqual(observation.effectLogs, []);
    assert.deepEqual(renderSpans(observation.spans), []);
  }), { timeout: 10_000 });

it.live("CT-REDACT-01: native rpc, helper channel and auth failures hand callers only fixed messages and classification flags",
  (t) => Effect.gen(function* () {
    const secrets = makeSecrets();
    const observation = observe(t);
    const fake = yield* fakeT3({ token: secrets.token, failure: nativeFailure(secrets) });
    const rpc = yield* NativeRpc.make({ baseUrl: fake.baseUrl, token: secrets.token }).pipe(Effect.provide(NativeEnvelope.layer));
    // a native read and the helper's webhook channel upsert, both refused with the secret-bearing native body
    for (const tag of ["orchestration.getTurnItem", "scheduledTasks.upsert"]) {
      const failure = yield* failureOf(Effect.flatMap(cancelAfter("5 seconds"), (cancel) => rpc.call(tag, { webhook: { path: secrets.webhookPath } }, cancel)),
        `${tag} unexpectedly succeeded`);
      assert.ok(failure instanceof SupervisorRpcError, tag);
      assert.deepEqual({ message: failure.message, outcome: failure.outcome, definiteRejection: failure.definiteRejection,
        providerDisabled: failure.providerDisabled, dispatchCommandFailure: failure.dispatchCommandFailure },
      { message: "T3 Supervisor access is unavailable.", outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false }, tag);
      assertNoLeak(tag, [inspect(failure, { depth: 20 }), JSON.stringify(failure), String(failure)], secrets);
    }
    assert.deepEqual(fake.traffic.requests, ["orchestration.getTurnItem", "scheduledTasks.upsert"]);

    // auth: a seed file holding a token-like value of the wrong length, and a forge without service state
    const directory = yield* temporaryDirectory("log-privacy-auth-");
    const auth = Effect.scoped(Layer.build(ServiceAuth.layer(directory))).pipe(Effect.provide(NodeFileSystem.layer));
    yield* auth;
    yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(join(directory, "access", "workflow-mcp-token"), `${secrets.token}x`, { mode: 0o600 })).pipe(
      Effect.orDie, Effect.provide(NodeFileSystem.layer));
    const seedFailure = yield* failureOf(auth, "a damaged seed was accepted");
    const missing = join(directory, "missing-instance");
    const forgeFailure = yield* failureOf(forgeDashboardToken(missing).pipe(Effect.provide(NodeFileSystem.layer)), "forge succeeded without state");
    assert.deepEqual([String(seedFailure), String(forgeFailure)],
      ["Error: invalid service auth workflow-mcp-token file", "Error: invalid service auth access directory"]);
    const authSecrets = { ...secrets, all: [...secrets.all, directory] };
    assertNoLeak("auth errors", [seedFailure, forgeFailure].map((error) => `${inspect(error, { depth: 20 })} ${JSON.stringify(error)}`), authSecrets);

    assert.deepEqual(observation.console, [], "these paths write no log line");
  }), { timeout: 10_000 });
