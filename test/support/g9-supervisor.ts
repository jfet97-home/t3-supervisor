import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Console, Effect, Layer, SubscriptionRef } from "effect";
import { SupervisorConfig as Configuration } from "../../src/config.js";
import { policyDbLayer } from "../../src/db.js";
import { SupervisorOwnership } from "../../src/project-supervisor-store.js";
import { makeStore } from "../../src/store.js";
import { NativeTransportLive, SupervisorStatusRef, type SupervisorStatus } from "../../src/supervisor.js";
import { T3Client, type T3ClientShape } from "../../src/t3.js";
import { ThreadPolicyStore } from "../../src/thread-policy.js";
import type { SupervisorSettings } from "../../src/types.js";

// the root services of a supervisor run over a fake T3 client, and the test seams the supervisor suites observe it through

/**
 * The services of the run: the catalog, the fake T3 client, the status, the thread-policy store on the run's PolicyDb
 * client (thread-settings.sqlite3), the ownership set and the native transport, over the configuration.
 */
export const rootServices = (settings: SupervisorSettings, status: SubscriptionRef.SubscriptionRef<SupervisorStatus>, client: T3ClientShape) =>
  Layer.mergeAll(
    makeStore(settings.dataDirectory), Layer.succeed(T3Client, client), Layer.succeed(SupervisorStatusRef, status),
    ThreadPolicyStore.layer.pipe(Layer.provide(policyDbLayer(settings.dataDirectory)), Layer.provide(NodeFileSystem.layer)),
    SupervisorOwnership.layer, NativeTransportLive, NodeFileSystem.layer,
  ).pipe(Layer.provideMerge(Layer.succeed(Configuration, settings)));

/** A view whose fields read the status ref's current value, so assertions read it as they read the baseline status object. */
export const statusView = (ref: SubscriptionRef.SubscriptionRef<SupervisorStatus>): SupervisorStatus =>
  Object.defineProperties({}, Object.fromEntries(Object.keys(SubscriptionRef.getUnsafe(ref)).map((key) =>
    [key, {enumerable: true, get: () => SubscriptionRef.getUnsafe(ref)[key as keyof SupervisorStatus]}]))) as SupervisorStatus;

/**
 * A Console that records the structured supervisor event lines in order and calls `onEvent` for each; every other console
 * output is kept out of the report. Provided to the run, it receives what logEvent writes through the current Console.
 */
export const eventConsole = (onEvent: (event: string, fields: Record<string, unknown>) => void = () => {}) => Effect.gen(function* () {
  const base = yield* Console.Console;
  const events: Array<Record<string, unknown>> = [];
  const log = (line: unknown) => {
    if (typeof line !== "string") return;
    let parsed: unknown;
    try {parsed = JSON.parse(line);} catch {return;}
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as {event?: unknown}).event !== "string") return;
    const fields = parsed as Record<string, unknown>;
    events.push(fields);
    onEvent(fields.event as string, fields);
  };
  const console: Console.Console = {...base, log};
  return {console, events};
});

/**
 * The current Clock with a pinnable wall time: while pinned, every read of the current time answers the pinned value, as
 * the baseline's mocked Date.now did; sleeps and the monotonic time stay the current clock's.
 */
export const pinnableClock = Effect.gen(function* () {
  const current = yield* Clock.Clock;
  let pinned: number | undefined;
  const millis = () => pinned ?? current.currentTimeMillisUnsafe();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: () => pinned === undefined ? current.currentTimeNanosUnsafe() : BigInt(pinned) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => pinned === undefined ? current.currentTimeNanosUnsafe() : BigInt(pinned) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => current.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: current.monotonicTimeNanos,
    sleep: (duration) => current.sleep(duration),
  };
  return {clock, pin: (at: number | undefined) => Effect.sync(() => {pinned = at;})};
});
