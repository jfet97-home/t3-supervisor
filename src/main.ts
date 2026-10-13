import { NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, Layer } from "effect";
import { readFile } from "node:fs/promises";
import { initializeRuntimeAuth, loadConfig } from "./config.js";
import { recapperLayer } from "./recap.js";
import { makeStore } from "./store.js";
import { createStatus, runSupervisor } from "./supervisor.js";
import { makeInputCoordinator } from "./input-coordinator.js";
import { makeNativeInputIntegration } from "./input-integration.js";
import { makeInputStore } from "./input-store.js";
import { InputReplyCleanup } from "./input-reply-cleanup.js";
import { makeInputTelegramClient } from "./input-telegram.js";
import { makeT3Client } from "./t3.js";
import { telegramClientLayer } from "./telegram.js";

import { ThreadPolicyStore } from "./thread-policy.js";
import { isSupervisorThread, loadSupervisorOwnership } from "./project-supervisor-store.js";

const config = loadConfig();
config.supervisorOwnedThreadIds = loadSupervisorOwnership(config.dataDirectory);
const status = createStatus(config);

NodeRuntime.runMain(Effect.gen(function* () {
  config.threadPolicy = yield* Effect.acquireRelease(
    Effect.sync(() => new ThreadPolicyStore(config.dataDirectory, { excludedThreadIds: config.excludedThreadIds, interactiveThreadId: config.inputInteractiveThreadId ?? null })),
    (store) => Effect.sync(() => store.close()),
  );
  yield* initializeRuntimeAuth(config);
  const token = yield* Effect.tryPromise(() => readFile(config.t3TokenFile, "utf8"));
  if (config.telegramEnabled && config.inputEnabled) {
    status.inputState = "starting";
    const inputWorker = Effect.gen(function* () {
      const responseToken = yield* Effect.tryPromise(() => readFile(config.inputTokenFile!, "utf8"));
      const store = yield* Effect.acquireRelease(
        Effect.sync(() => makeInputStore(config.dataDirectory)),
        (value) => Effect.sync(() => value.close()),
      );
      store.recoverInterrupted(Date.now());
      const replyCleanup = yield* Effect.acquireRelease(
        Effect.sync(() => new InputReplyCleanup(config.dataDirectory)),
        (value) => Effect.sync(() => value.close()),
      );
      const coordinator = makeInputCoordinator({
        store,
        replyCleanup,
        routerOnlyInput: true,
        readThreadPolicy: () => config.threadPolicy!.get(),
        excludedThreadIds: config.excludedThreadIds,
        native: makeNativeInputIntegration({ baseUrl: config.t3Url, readToken: token.trim(), responseToken: responseToken.trim(), isSupervisorThread: thread => isSupervisorThread(config, thread) }),
        telegram: makeInputTelegramClient(config.mcpxUrl, {
          onReceiptFailure: (deliveryKey) => console.log(JSON.stringify({ event: "input_receipt_unconfirmed", deliveryKey })),
        }),
        pollIntervalMs: config.inputPollMs ?? 1_000,
        refreshPresentationOnStart: true,
        onError: (phase) => { status.inputState = "degraded"; status.inputLastErrorPhase = phase; },
      });
      const cycle = Effect.gen(function* () {
        yield* Effect.tryPromise(() => coordinator.runOnce(false)).pipe(Effect.catch(() => Effect.sync(() => {
          status.inputState = "degraded";
        })));
        const input = coordinator.status();
        status.inputRequests = input.requests;
        status.inputUncertain = input.uncertain;
        status.inputMessages = input.messages;
        status.inputPendingCleanup = input.pendingCleanup;
        status.inputReplyCleanupExpired = input.replyCleanupExpired;
        status.inputLastErrorPhase = input.lastErrorPhase;
        status.inputCapacity = input.capacity;
        status.inputHeartbeat = input.lastCycleAt ? Date.parse(input.lastCycleAt) : status.inputHeartbeat;
        status.inputState = input.lastErrorPhase === null && input.lastCycleAt !== null && input.uncertain === 0
          ? "ready" : "degraded";
        yield* Effect.sleep(config.inputPollMs ?? 1_000);
      }).pipe(Effect.forever);
      yield* cycle;
    }).pipe(Effect.scoped, Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause) : Effect.gen(function* () {
      status.inputState = "degraded";
      status.inputLastErrorPhase = "input_worker_initialization";
      console.log(JSON.stringify({ event: "input_worker_initialization_failed" }));
      yield* Effect.sleep("10 seconds");
    })), Effect.forever);
    yield* Effect.forkScoped(inputWorker);
  }
  const services = Layer.mergeAll(
    makeStore(config.dataDirectory),
    makeT3Client({ baseUrl: config.t3Url, token: token.trim() }),
    config.telegramEnabled
      ? Layer.mergeAll(recapperLayer(config), telegramClientLayer(config.mcpxUrl))
      : Layer.empty,
  );
  yield* runSupervisor(config, status).pipe(Effect.provide(services));
}).pipe(Effect.scoped));
