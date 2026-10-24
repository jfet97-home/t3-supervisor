import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { type DashboardKey } from "./dashboard-events.js";

type Change = {readonly cursor: number; readonly keys: ReadonlyArray<DashboardKey> | null};
export type DashboardEvent = {readonly _tag: "Event"; readonly event: "reset" | "invalidate"; readonly id: string; readonly data: string};

// this bounded process-local hint bus owns no documents or durable history; a gap reconciles through the typed readers
export class DashboardUpdates extends Context.Service<DashboardUpdates, {
  readonly publish: (keys: ReadonlyArray<DashboardKey> | null) => Effect.Effect<void>;
  readonly stream: Stream.Stream<DashboardEvent>;
}>()("t3-supervisor/DashboardUpdates") {
  static readonly make = Effect.gen(function* () {
    const changes = yield* Effect.acquireRelease(PubSub.sliding<Change>(64), PubSub.shutdown);
    let cursor = 0;
    const publish = (keys: ReadonlyArray<DashboardKey> | null) => Effect.suspend(() =>
      PubSub.publish(changes, {cursor: ++cursor, keys})).pipe(Effect.asVoid);
    const stream = Stream.unwrap(Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(changes);
      let previous = cursor;
      const reset = (): DashboardEvent => ({_tag: "Event", event: "reset", id: String(previous), data: "{\"keys\":[]}"});
      return Stream.concat(Stream.succeed(reset()), Stream.fromSubscription(queue).pipe(
        Stream.groupedWithin(64, "20 millis"), Stream.map(batch => {
          const keys = [...new Set(batch.flatMap(change => change.keys ?? []))];
          const lost = batch.some((change, index) => change.cursor !== (index === 0 ? previous : batch[index - 1]!.cursor) + 1);
          previous = batch[batch.length - 1]!.cursor;
          return lost || batch.some(change => change.keys === null) || keys.length > 64
            ? reset() : {_tag: "Event" as const, event: "invalidate" as const, id: String(previous), data: JSON.stringify({keys})};
        })));
    }));
    return DashboardUpdates.of({publish, stream});
  });
  static readonly layer = Layer.effect(DashboardUpdates, DashboardUpdates.make);
}

// headless store users have no dashboard observer; a running dashboard supplies the same scoped service to all its stores
export const dashboardInvalidation = (db: SqlClient) => Effect.map(Effect.serviceOption(DashboardUpdates), observer =>
  (keys: ReadonlyArray<DashboardKey> | null, before?: unknown, after?: unknown): Effect.Effect<void> =>
    observer._tag === "None" || before !== undefined && semanticValue(before) === semanticValue(after)
      ? Effect.void : db.afterCommit(observer.value.publish(keys)));

// collection clocks and delivery-observation counters alone are not changes to the operator's task or controls
const bookkeeping = new Set(["updatedAt", "checkedAt", "lastCycleAt", "lastSeenAt", "visibilityMisses", "stopObservedAt", "quietSince"]);
const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {return JSON.parse(value) as unknown;} catch {return value;}
};
const semanticValue = (value: unknown): string | undefined => JSON.stringify(jsonValue(value), (key, item: unknown) =>
  bookkeeping.has(key) ? undefined : key === "document" || key === "value" ? jsonValue(item) : item);
