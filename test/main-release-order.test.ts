import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { ConfigProvider, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Stream, SubscriptionRef } from "effect";
import { Store } from "../src/store.js";
import { supervise, SupervisorLive, SupervisorStatusRef, type SupervisorStatus } from "../src/supervisor.js";
import { ThreadPolicyStore } from "../src/thread-policy.js";
import { supervisorHarness, type SupervisorHarness } from "./support/cli-supervisor.js";
import { portState } from "./support/g11-http.js";
import { mockMethod } from "./support/node-test.js";

// target regression for D-10: the server graph of src/main.ts over a loopback fake T3, interrupted after readiness.
// it.live: the run listens on real loopback ports and its fake T3 peer is a loopback server (the cli harness's)

interface Release {
  readonly listeners: Readonly<Record<"health" | "ui" | "mcp", "open" | "refused">>;
  readonly catalog: "open" | "closed";
  readonly threadPolicy: "open" | "closed";
}

// relative paths under the data directory, sorted; none before the directory exists
const dataFiles = (harness: SupervisorHarness) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return [...yield* fs.readDirectory(harness.dataDirectory, { recursive: true })].sort();
}).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string[]>([])), Effect.orDie, Effect.provide(NodeFileSystem.layer));

const ready = (status: SupervisorStatus) =>
  status.supervisionState === "ready" && status.t3Connected && status.activation !== null && status.storeState === "ready";

it.live("CT-MAIN-02: the supervision run and its health, UI and MCP listeners release before the catalog and thread-policy stores", (t) =>
  Effect.gen(function* () {
    const harness = yield* Effect.promise(() => supervisorHarness(t, { activeThreads: 1, archiveThreads: 1 }));
    const events: unknown[] = [];
    mockMethod(t, console, "log", (line: unknown) => {
      if (typeof line === "string" && line.startsWith("{")) events.push((JSON.parse(line) as { event?: unknown }).event);
    });
    const listeners = Effect.all({ health: portState(harness.ports.health), ui: portState(harness.ports.ui), mcp: portState(harness.ports.mcp) });
    const observed = yield* Deferred.make<SubscriptionRef.SubscriptionRef<SupervisorStatus>>();
    const released = yield* Deferred.make<Release>();
    // built after the root services and released first among them: it hands over the status and, once the services begin
    // to release, records the listeners and whether the catalog and thread-policy stores still answer
    const observer = Layer.effectDiscard(Effect.gen(function* () {
      const status = yield* SupervisorStatusRef;
      const store = yield* Store;
      const policy = yield* ThreadPolicyStore;
      yield* Deferred.succeed(observed, status);
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        const states = yield* listeners;
        const answers = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit) ? "open" as const : "closed" as const;
        const catalog = answers(yield* Effect.exit(store.cursor("active")));
        const threadPolicy = answers(yield* Effect.exit(policy.get()));
        yield* Deferred.succeed(released, { listeners: states, catalog, threadPolicy });
      }));
    }));
    const provider = ConfigProvider.layer(ConfigProvider.fromEnvRecord(harness.env, { preserveEmptyStrings: true }));
    const fiber = yield* Effect.forkScoped(supervise(observer.pipe(Layer.provideMerge(SupervisorLive), Layer.provide(provider))));

    const status = yield* Deferred.await(observed).pipe(Effect.timeout("5 seconds"));
    yield* SubscriptionRef.changes(status).pipe(Stream.filter(ready), Stream.runHead, Effect.timeout("5 seconds"));
    assert.deepEqual(yield* listeners, { health: "open", ui: "open", mcp: "open" });

    yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
    assert.deepEqual(yield* Deferred.await(released).pipe(Effect.timeout("1 second")),
      { listeners: { health: "refused", ui: "refused", mcp: "refused" }, catalog: "open", threadPolicy: "open" });
    // after the services released, every database is closed: no wal, shm or journal sidecar remains
    assert.deepEqual((yield* dataFiles(harness)).filter((file) => /-(wal|shm|journal)$/u.test(file)), []);
    // shutdown logs nothing after the start: no operation_deferred or supervision_unavailable line
    assert.deepEqual(events, ["supervisor_started"]);
  }), { timeout: 10_000 });
