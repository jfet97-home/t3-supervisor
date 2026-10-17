import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Effect, Fiber, Layer} from "effect";
import test from "node:test";
import {makeStore, Store} from "../src/store.js";
import {createStatus, readiness, runSupervisor} from "../src/supervisor.js";
import {T3Client, T3TransportError, type T3ClientShape} from "../src/t3.js";
import type {ProjectInfo, SupervisorConfig} from "../src/types.js";

const config = (directory: string): SupervisorConfig => ({
  dataDirectory: directory,
  t3Url: "http://unused",
  t3TokenFile: "unused",
  excludedThreadIds: [],
  healthPort: 0,
});

test("readiness depends on native T3 connection, activation, catalog health, and enabled supervision", () => {
  const settings = config("/tmp/supervisor-readiness");
  settings.uiPort = 9008;
  const status = createStatus(settings);
  const now = Date.now();
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

test("native T3 events persist into the generic catalog and mark the service connected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-loop-"));
  const settings = config(directory);
  const status = createStatus(settings);
  const project: ProjectInfo = {id: "project", title: "Project", workspaceRoot: "/work/project"};
  const fake: T3ClientShape = {
    descriptor: () => Effect.succeed({environmentId: "environment", serverVersion: "test", orchestrationProtocolVersion: 2}),
    projection: () => Effect.fail(new T3TransportError("No projection is expected")),
    watch: (_cursor, onItem) => onItem({stream: "active", item: {kind: "project.updated", sequence: 1, project}})
      .pipe(Effect.andThen(Effect.never)),
  };
  try {
    const fiber = Effect.runFork(Effect.scoped(Effect.provide(
      runSupervisor(settings, status),
      Layer.mergeAll(makeStore(directory), Layer.succeed(T3Client, fake)),
    )));
    try {
      const deadline = Date.now() + 3_000;
      while ((!status.t3Connected || status.activation === null) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(status.t3Connected, true);
      assert.equal(status.environmentId, "environment");
      assert.ok(status.activation);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    const catalog = await Effect.runPromise(Effect.scoped(Effect.provide(Store.use(store => store.catalog()), makeStore(directory))));
    assert.deepEqual(catalog.projects.map(item => item.project.id), ["project"]);
  } finally {await rm(directory, {recursive: true, force: true});}
});
