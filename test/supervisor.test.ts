import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Clock, Effect, Fiber, Option, Stream, SubscriptionRef} from "effect";
import {makeStore, Store} from "../src/store.js";
import {createStatus, readiness, supervise} from "../src/supervisor.js";
import {T3TransportError, type T3ClientShape} from "../src/t3.js";
import type {ProjectInfo, SupervisorConfig} from "../src/types.js";
import {dataDirectory} from "./support/g9-stores.js";
import {rootServices} from "./support/g9-supervisor.js";

const config = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
});

it("readiness depends on native T3 connection, activation, catalog health, and enabled supervision", () => {
  const settings = config("/tmp/supervisor-readiness");
  settings.uiPort = 9008;
  const now = Date.now();
  const status = createStatus(settings, now);
  status.heartbeat = now;
  assert.equal(readiness(status, settings, now).ready, false);
  status.activation = new Date(now).toISOString();
  status.t3Connected = true;
  status.storeState = "ready";
  assert.equal(readiness(status, settings, now).ready, false);
  status.supervisionState = "ready";
  assert.equal(readiness(status, settings, now).ready, true);
  status.supervisionState = "degraded";
  assert.equal(readiness(status, settings, now).ready, false);
});

// it.live: the run listens on a real health port and the catalog and thread-policy files are real; the 3 s bound is a hang
// guard on the live clock
it.live("native T3 events persist into the generic catalog and mark the service connected", () => Effect.gen(function* () {
  const directory = yield* dataDirectory("supervisor-loop-");
  const settings = config(directory);
  const statusRef = yield* SubscriptionRef.make(createStatus(settings, yield* Clock.currentTimeMillis));
  const project: ProjectInfo = {id: "project", title: "Project", workspaceRoot: "/work/project"};
  const fake: T3ClientShape = {
    descriptor: () => Effect.succeed({environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2}),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem({stream: "active", item: {kind: "project.updated", sequence: 1, project}})
      .pipe(Effect.andThen(Effect.never)),
  };
  const fiber = yield* Effect.forkScoped(supervise(rootServices(settings, statusRef, fake)));
  // the first status in which the stored item marked the service connected after activation
  const status = Option.getOrThrow(yield* SubscriptionRef.changes(statusRef).pipe(
    Stream.filter((current) => current.t3Connected && current.activation !== null), Stream.runHead, Effect.timeout("3 seconds")));
  assert.equal(status.t3Connected, true);
  assert.equal(status.environmentId, "environment");
  assert.ok(status.activation);
  yield* Fiber.interrupt(fiber);
  const catalog = yield* Store.use(store => store.catalog()).pipe(Effect.provide(makeStore(directory)));
  assert.deepEqual(catalog.projects.map(item => item.project.id), ["project"]);
}));
