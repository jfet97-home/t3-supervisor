import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Cause, Effect, Exit, Fiber, Layer, Logger, SubscriptionRef, Tracer } from "effect";
import { it, type TestContext } from "vitest";
import { SupervisorConfig as Configuration } from "../src/config.js";
import { SupervisorOwnership } from "../src/project-supervisor-store.js";
import { createServiceAuth, forgeDashboardToken } from "../src/service-auth.js";
import { makeStore, type Store } from "../src/store.js";
import { makeSupervisorRpc, SupervisorRpcError } from "../src/supervisor-native.js";
import { createStatus, readiness, supervise, SupervisorStatusRef, type SupervisorStatus } from "../src/supervisor.js";
import { makeT3Client, T3Client, T3TransportError, type T3ClientShape } from "../src/t3.js";
import { ThreadPolicy } from "../src/thread-policy.js";
import type { SupervisorConfig } from "../src/types.js";
import { startFakeT3 } from "./support/cli-fake-t3.js";
import { fingerprint, leakedSecrets } from "./support/cli-process.js";
import { after, mockMethod } from "./support/node-test.js";

// baseline log privacy: secrets injected into native, helper and auth failures, observed at every baseline log/span seam

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
  until(predicate: (lines: ReadonlyArray<string>) => boolean, timeoutMs: number, label: string): Promise<void>;
}

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
    until: (predicate, timeoutMs, label) => new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!predicate(lines)) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no ${label} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.add(check);
      check();
    }),
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

// the status service over a SubscriptionRef, seen through a live view so the checks read the current status as they read
// the baseline status object
const statusRefs = new WeakMap<SupervisorStatus, SubscriptionRef.SubscriptionRef<SupervisorStatus>>();
const liveStatus = (settings: SupervisorConfig): SupervisorStatus => {
  const ref = Effect.runSync(SubscriptionRef.make(createStatus(settings, Date.now())));
  const view = Object.defineProperties({}, Object.fromEntries(Object.keys(SubscriptionRef.getUnsafe(ref)).map((key) =>
    [key, { enumerable: true, get: () => SubscriptionRef.getUnsafe(ref)[key as keyof SupervisorStatus] }]))) as SupervisorStatus;
  statusRefs.set(view, ref);
  return view;
};

// the services of the run: the given catalog and T3 client, the status and the root thread-policy and ownership services
const services = (settings: SupervisorConfig, status: SupervisorStatus, base: Layer.Layer<Store | T3Client, unknown>) => Layer.mergeAll(
  base, Layer.succeed(SupervisorStatusRef, statusRefs.get(status)!), ThreadPolicy.layer, SupervisorOwnership.layer,
).pipe(Layer.provideMerge(Layer.succeed(Configuration, settings)));

// the /health body the status would serve
const healthBody = (status: SupervisorStatus, settings: SupervisorConfig) =>
  JSON.stringify({ ok: false, readiness: readiness(status, settings), ...status });

const until = async (condition: () => boolean, timeoutMs: number, label: string) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`${label} not reached within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const temporaryDirectory = async (t: TestContext, prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  after(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
};

const assertNoLeak = (label: string, outputs: ReadonlyArray<string>, secrets: Secrets) => {
  // failures name only fingerprints of the leaked values
  assert.deepEqual(leakedSecrets(outputs.join("\n"), secrets.all), [], `${label} leaks ${secrets.all.map(fingerprint).join(", ")}`);
};

it("CT-REDACT-01: native transport failures carrying a token, a native error body and a webhook URL leave only phase classifications in logs, status and spans",
  { timeout: 10_000 }, async (t) => {
    const secrets = makeSecrets();
    const observation = observe(t);

    // descriptor answered with a 500 whose body carries the secrets: the retry records only the phase
    const refusing = await startFakeT3({ token: secrets.token, descriptor: "failing", failure: nativeFailure(secrets) });
    after(t, () => refusing.close());
    const refusedDirectory = await temporaryDirectory(t, "log-privacy-descriptor-");
    const refusedConfig = config(refusedDirectory);
    const refusedStatus = liveStatus(refusedConfig);
    const refused = Effect.runFork(instrumented(supervise(services(refusedConfig, refusedStatus,
      Layer.mergeAll(makeStore(refusedDirectory), makeT3Client({ baseUrl: refusing.baseUrl, token: secrets.token })))), observation));
    try {
      await refusing.until((traffic) => traffic.http.length > 0, 5_000, "a descriptor request");
      await until(() => refusedStatus.lastErrorPhase === "t3_authentication", 5_000, "the descriptor failure phase");
    } finally {
      await Effect.runPromise(Fiber.interrupt(refused));
    }
    assertNoLeak("descriptor status", [healthBody(refusedStatus, refusedConfig)], secrets);

    // shell subscriptions answered with an Exit failure carrying the secrets: the guard logs the phase only
    const failing = await startFakeT3({ token: secrets.token, failure: nativeFailure(secrets), failSubscriptions: true });
    after(t, () => failing.close());
    const watchDirectory = await temporaryDirectory(t, "log-privacy-watch-");
    const watchConfig = config(watchDirectory);
    const watchStatus = liveStatus(watchConfig);
    const watching = Effect.runFork(instrumented(supervise(services(watchConfig, watchStatus,
      Layer.mergeAll(makeStore(watchDirectory), makeT3Client({ baseUrl: failing.baseUrl, token: secrets.token })))), observation));
    try {
      await observation.until((lines) => lines.some((line) => line.includes("operation_deferred")), 5_000, "operation_deferred line");
    } finally {
      await Effect.runPromise(Fiber.interrupt(watching));
    }
    assert.equal(watchStatus.lastErrorPhase, "t3_stream");
    assert.deepEqual(failing.traffic.requests, ["orchestration.subscribeShell", "orchestration.subscribeArchivedShell"]);

    assertNoLeak("console", observation.console, secrets);
    assertNoLeak("effect logs", observation.effectLogs, secrets);
    assertNoLeak("spans", renderSpans(observation.spans), secrets);
    assertNoLeak("watch status", [healthBody(watchStatus, watchConfig)], secrets);
    // the baseline logs exactly these classifications, writes no Effect log record and creates no span on these paths
    assert.deepEqual(supervisorEvents(observation.console), [
      { event: "supervisor_started" },
      { event: "supervisor_started" },
      { event: "operation_deferred", phase: "t3_stream" },
    ]);
    assert.deepEqual(observation.effectLogs, []);
    assert.deepEqual(renderSpans(observation.spans), []);
  });

it("CT-REDACT-01: nested causes carrying a token, a native error body and a webhook URL reach the logger only as phase classifications",
  { timeout: 10_000 }, async (t) => {
    const secrets = makeSecrets();
    const observation = observe(t);
    const directory = await temporaryDirectory(t, "log-privacy-nested-");
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
    const status = liveStatus(settings);
    const fiber = Effect.runFork(instrumented(supervise(services(settings, status,
      Layer.mergeAll(makeStore(directory), Layer.succeed(T3Client, client)))), observation));
    try {
      await observation.until((lines) => lines.some((line) => line.includes("supervision_unavailable")) &&
        lines.some((line) => line.includes("operation_deferred")), 5_000, "supervision and watch failure lines");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    assert.equal(status.supervisionState, "degraded");
    assertNoLeak("console", observation.console, secrets);
    assertNoLeak("effect logs", observation.effectLogs, secrets);
    assertNoLeak("spans", renderSpans(observation.spans), secrets);
    assertNoLeak("status", [healthBody(status, settings)], secrets);
    const sortedEvents = supervisorEvents(observation.console).map((fields) => JSON.stringify(fields)).sort();
    assert.deepEqual(sortedEvents, [
      JSON.stringify({ event: "operation_deferred", phase: "t3_stream" }),
      JSON.stringify({ event: "supervision_unavailable" }),
      JSON.stringify({ event: "supervisor_started" }),
    ]);
    assert.deepEqual(observation.effectLogs, []);
    assert.deepEqual(renderSpans(observation.spans), []);
  });

it("CT-REDACT-01: native rpc, helper channel and auth failures hand callers only fixed messages and classification flags",
  { timeout: 10_000 }, async (t) => {
    const secrets = makeSecrets();
    const observation = observe(t);
    const fake = await startFakeT3({ token: secrets.token, failure: nativeFailure(secrets) });
    after(t, () => fake.close());
    const rpc = makeSupervisorRpc(fake.baseUrl, secrets.token);
    // a native read and the helper's webhook channel upsert, both refused with the secret-bearing native body
    for (const tag of ["orchestration.getTurnItem", "scheduledTasks.upsert"]) {
      const failure = await rpc(tag, { webhook: { path: secrets.webhookPath } }, AbortSignal.timeout(5_000)).then(
        () => assert.fail(`${tag} unexpectedly succeeded`), (error: unknown) => error);
      assert.ok(failure instanceof SupervisorRpcError, tag);
      assert.deepEqual({ message: failure.message, outcome: failure.outcome, definiteRejection: failure.definiteRejection,
        providerDisabled: failure.providerDisabled, dispatchCommandFailure: failure.dispatchCommandFailure },
      { message: "T3 Supervisor access is unavailable.", outcome: "uncertain", definiteRejection: false, providerDisabled: false, dispatchCommandFailure: false }, tag);
      assertNoLeak(tag, [inspect(failure, { depth: 20 }), JSON.stringify(failure), String(failure)], secrets);
    }
    assert.deepEqual(fake.traffic.requests, ["orchestration.getTurnItem", "scheduledTasks.upsert"]);

    // auth: a seed file holding a token-like value of the wrong length, and a forge without service state
    const directory = await temporaryDirectory(t, "log-privacy-auth-");
    const auth = await createServiceAuth(directory);
    auth.close();
    await writeFile(join(directory, "access", "workflow-mcp-token"), `${secrets.token}x`, { mode: 0o600 });
    const seedFailure = await createServiceAuth(directory).then(() => assert.fail("a damaged seed was accepted"), (error: unknown) => error);
    const missing = join(directory, "missing-instance");
    const forgeFailure = await forgeDashboardToken(missing).then(() => assert.fail("forge succeeded without state"), (error: unknown) => error);
    assert.deepEqual([String(seedFailure), String(forgeFailure)],
      ["Error: invalid service auth workflow-mcp-token file", "Error: invalid service auth access directory"]);
    const authSecrets = { ...secrets, all: [...secrets.all, directory] };
    assertNoLeak("auth errors", [seedFailure, forgeFailure].map((error) => `${inspect(error, { depth: 20 })} ${JSON.stringify(error)}`), authSecrets);

    assert.deepEqual(observation.console, [], "these paths write no log line");
  });
