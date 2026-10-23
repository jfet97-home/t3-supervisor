import { parentPort, workerData } from "node:worker_threads";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { ServiceAuth } from "../../src/service-auth.js";

// one service auth instance on its own worker thread (test/service-auth.test.ts): it reports ready, blocks on the shared
// barrier, consumes the grant once, releases the instance and reports whether its login won

const data = workerData as { directory: string; token: string; barrier: SharedArrayBuffer };
const post = (message: { kind: "ready" | "result" | "failure"; accepted?: boolean }) => Effect.sync(() => parentPort?.postMessage(message));

const consume = Effect.gen(function* () {
  const auth = yield* ServiceAuth;
  yield* post({ kind: "ready" });
  Atomics.wait(new Int32Array(data.barrier), 0, 0);
  return (yield* auth.login(data.token)) !== null;
}).pipe(Effect.provide(ServiceAuth.layer(data.directory)));

// the thread's entry: signals reach only the main thread, so no runMain signal handling applies here
Effect.runFork(consume.pipe(
  Effect.matchCauseEffect({ onSuccess: (accepted) => post({ kind: "result", accepted }), onFailure: () => post({ kind: "failure" }) }),
  Effect.provide(NodeFileSystem.layer),
));
