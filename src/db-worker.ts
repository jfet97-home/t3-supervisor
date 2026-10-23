import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import { serveDatabase } from "./db-worker-serve.js";

// the entry of a database worker thread (src/db.ts starts one per opened database file): it serves until the main thread
// closes it, and its exit ends only this thread. every thread loads its own copy of the modules it imports, so the worker
// side imports single modules, never the package indexes, which load every module of the package
NodeRuntime.runMain(serveDatabase.pipe(Effect.provide(NodeWorkerRunner.layer)), {disableErrorReporting: true});
