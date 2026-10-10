import { Effect, Layer } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, makeStore } from "../src/store.js";
import { T3Client, makeT3Client } from "../src/t3.js";

const tokenPath = process.env.T3_TOKEN_FILE;
if (!tokenPath) throw new Error("Set T3_TOKEN_FILE to the private credential path");
const token = (await readFile(tokenPath, "utf8")).trim();
const directory = await mkdtemp(join(tmpdir(), "supervisor-t3-probe-"));
const snapshots = new Set<string>();
let threads = 0;
let verified = false;
try {
  await Effect.runPromise(Effect.gen(function* () {
    const store = yield* Store;
    const source = yield* T3Client;
    const descriptor = yield* source.descriptor();
    yield* store.activate(descriptor.environmentId, Date.now());
    yield* source.watch(undefined, (item) => Effect.gen(function* () {
      yield* store.ingest(item);
      if (item.item.kind === "snapshot" && item.item.resolvedRepositoryIdentityRoots === undefined) {
        snapshots.add(item.stream);
        const snapshot = item.item.snapshot as { threads: unknown[] };
        threads += snapshot.threads.length;
      }
      if (snapshots.has("active") && snapshots.has("archive")) {
        verified = true;
        return yield* Effect.fail(new Error("probe_complete"));
      }
    }));
  }).pipe(
    Effect.provide(Layer.mergeAll(makeStore(directory), makeT3Client({ baseUrl: process.env.T3_URL ?? "http://127.0.0.1:3773", token }))),
    Effect.scoped,
    Effect.timeout("30 seconds"),
  ));
} catch {
  if (!verified) {
    console.log(JSON.stringify({ readOnly: true, activeSnapshot: snapshots.has("active"), archiveSnapshot: snapshots.has("archive"), verified: false }));
    process.exitCode = 1;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
if (verified) console.log(JSON.stringify({ readOnly: true, activeSnapshot: true, archiveSnapshot: true, threads, verified: true, notificationsSent: 0 }));
