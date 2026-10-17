import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { makeStore } from "./store.js";
import { createStatus, runSupervisor } from "./supervisor.js";
import { makeT3Client } from "./t3.js";
import { ThreadPolicyStore } from "./thread-policy.js";
import { loadSupervisorOwnership } from "./project-supervisor-store.js";

const config = loadConfig();
config.supervisorOwnedThreadIds = loadSupervisorOwnership(config.dataDirectory);
const status = createStatus(config);

NodeRuntime.runMain(Effect.gen(function* () {
  config.threadPolicy = yield* Effect.acquireRelease(
    Effect.sync(() => new ThreadPolicyStore(config.dataDirectory, { excludedThreadIds: config.excludedThreadIds })),
    (store) => Effect.sync(() => store.close()),
  );
  const token = yield* Effect.tryPromise(() => readFile(config.t3TokenFile, "utf8"));
  const services = Layer.mergeAll(
    makeStore(config.dataDirectory),
    makeT3Client({ baseUrl: config.t3Url, token: token.trim() }),
  );
  yield* runSupervisor(config, status).pipe(Effect.provide(services));
}).pipe(Effect.scoped));
