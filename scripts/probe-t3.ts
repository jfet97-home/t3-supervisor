import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Clock, Config, Console, Data, Effect, FileSystem, Layer, type PlatformError, Redacted, Ref, Schema } from "effect";
import { Store, makeStore } from "../src/store.js";
import { T3Client, makeT3Client } from "../src/t3.js";
import type { SourceItem } from "../src/types.js";

// a read-only check that the T3 read token reaches both shell snapshots: it reads the descriptor and ingests the active
// and archived shells into a private catalog, and never dispatches, writes to T3 or sends notifications

// the token file is unset, unreadable or blank; the message never carries the token
class ProbeTokenMissing extends Data.TaggedError("ProbeTokenMissing")<{ readonly message: string }> {}

// both snapshots were not seen before the deadline or a failure
class ProbeIncomplete extends Data.TaggedError("ProbeIncomplete")<{ readonly activeSnapshot: boolean; readonly archiveSnapshot: boolean }> {}

// raised inside the item handler that saw the second snapshot, so that chunk is never acknowledged
class ProbeVerified extends Data.TaggedError("ProbeVerified") {}

interface Seen {
  readonly snapshots: ReadonlySet<SourceItem["stream"]>;
  readonly threads: number;
}

const T3Token = Schema.RedactedFromValue(Schema.Trim.check(Schema.isNonEmpty()));
const t3Url = Config.String("T3_URL").pipe(Config.withDefault("http://127.0.0.1:3773"));

// node's errno message names only the code, the system call and the path
const unreadable = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return new ProbeTokenMissing({
    message: cause instanceof Error && "code" in cause ? `T3_TOKEN_FILE could not be read: ${cause.message}` : "T3_TOKEN_FILE could not be read",
  });
};

const readToken = Effect.gen(function* () {
  const path = yield* Config.NonEmptyString("T3_TOKEN_FILE").pipe(
    Effect.mapError(() => new ProbeTokenMissing({ message: "Set T3_TOKEN_FILE to the private credential path" })));
  const text = yield* FileSystem.FileSystem.use((files) => files.readFileString(path)).pipe(Effect.mapError(unreadable));
  return yield* Schema.decodeUnknownEffect(T3Token)(text).pipe(Effect.mapError(() => new ProbeTokenMissing({ message: "T3_TOKEN_FILE holds no token" })));
});

const watchSnapshots = (seen: Ref.Ref<Seen>) => Effect.gen(function* () {
  const store = yield* Store;
  const source = yield* T3Client;
  const descriptor = yield* source.descriptor();
  yield* store.activate(descriptor.environmentId, yield* Clock.currentTimeMillis);
  return yield* source.watch(undefined, (item) => Effect.gen(function* () {
    yield* store.ingest(item);
    if (item.item.kind === "snapshot" && item.item.resolvedRepositoryIdentityRoots === undefined) {
      const snapshot = item.item.snapshot as { threads: unknown[] };
      const count = snapshot.threads.length;
      yield* Ref.update(seen, ({ snapshots, threads }) => ({ snapshots: new Set([...snapshots, item.stream]), threads: threads + count }));
    }
    const { snapshots } = yield* Ref.get(seen);
    if (snapshots.has("active") && snapshots.has("archive")) return yield* new ProbeVerified();
  }));
});

// the catalog lives in a temp directory removed after the store closed, also on interruption; an interrupt is no verdict
// and ends the probe with its interrupt exit, any other ending before verification is incomplete
const probe = Effect.gen(function* () {
  const token = yield* readToken;
  const seen = yield* Ref.make<Seen>({ snapshots: new Set(), threads: 0 });
  yield* Effect.gen(function* () {
    const directory = yield* FileSystem.FileSystem.use((files) => files.makeTempDirectoryScoped({ prefix: "supervisor-t3-probe-" }));
    const client = Layer.unwrap(Effect.map(t3Url, (baseUrl) => makeT3Client({ baseUrl, token: Redacted.value(token) })));
    return yield* watchSnapshots(seen).pipe(Effect.provide(Layer.mergeAll(makeStore(directory), client)), Effect.timeout("30 seconds"));
  }).pipe(
    Effect.scoped,
    Effect.catchTag("ProbeVerified", () => Effect.void),
    Effect.catchCause((cause) => Cause.hasInterrupts(cause)
      ? Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter((reason): reason is Cause.Die | Cause.Interrupt => !Cause.isFailReason(reason))))
      : Ref.get(seen).pipe(Effect.flatMap(({ snapshots }) =>
        Effect.fail(new ProbeIncomplete({ activeSnapshot: snapshots.has("active"), archiveSnapshot: snapshots.has("archive") }))))),
  );
  return (yield* Ref.get(seen)).threads;
});

// the verdict is the only stdout line; a token failure prints its fixed message and no stack; both failures exit 1
NodeRuntime.runMain(probe.pipe(
  Effect.tap((threads) => Console.log(JSON.stringify({ readOnly: true, activeSnapshot: true, archiveSnapshot: true, threads, verified: true, notificationsSent: 0 }))),
  Effect.tapError((error) => error._tag === "ProbeIncomplete"
    ? Console.log(JSON.stringify({ readOnly: true, activeSnapshot: error.activeSnapshot, archiveSnapshot: error.archiveSnapshot, verified: false }))
    : Console.error(error.message)),
  Effect.provide(NodeFileSystem.layer),
), { disableErrorReporting: true });
