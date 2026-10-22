import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { projectDefinitionsFacade } from "../src/guidance-application.js";
import { ProjectConfigEditorService, type ProjectConfigDefinitions } from "../src/project-config-editor.js";
import { ProjectDefinitions, type ProjectDefinitionSetupInput } from "../src/project-definitions.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import { asLoaderOptions, asProjectFiles, asProjectWriter, type ProjectFiles, type ProjectWriter } from "./support/native-files-promise.js";
import { deferred, loopTurn, within } from "./support/c3b-http.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

// target regression for the per-root locks: four saves and four setups queue behind a fifth on one checkout, the third
// arrival is cancelled, and the others run in arrival order as the baseline promise chain (022cbb5) ran them; a later
// operation on the same root completes, so every lock was released. conversations a..f all bind the registered root
// /workspace; the promise variants use the root facade with the caller's signal, the effect variants interrupt the fiber

type Fixture = ReturnType<typeof makeDefinitionFixture>;
const queued = ["b", "c", "d", "e"] as const;

// a recorded event log with a promise per label, resolved once that label is recorded
const eventLog = () => {
  const events: string[] = [];
  const waiting: Array<() => void> = [];
  const record = (event: string) => {events.push(event);for (const check of waiting.splice(0)) check();};
  const recorded = (event: string) => new Promise<void>(resolve => {
    const check = () => {if (events.includes(event)) resolve();else waiting.push(check);};
    check();
  });
  return {events, record, recorded};
};

const indexedCheckout = () => {
  const f = makeDefinitionFixture({threadRoot: null});
  f.addFile(f.root, ".t3-supervisor/project.yaml", "workflows:\n  - path: workflows/local-flow.yaml\n    summary: Run the local flow.\nsteps:\n  - path: steps/local-step.md\n    summary: Check the local behavior.\n");
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: local-step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  return f;
};
const save = (threadId: string, revision: string): ProjectConfigSave => ({projectId: "project", threadId, expectedRevision: revision, config: {
  workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
  steps: [{path: "steps/local-step.md", summary: `Draft ${threadId}.`, required: false}],
}});
// a project writer whose first write waits for release
const heldWriter = (f: Fixture, record: (event: string) => void) => {
  const firstWrite = deferred();
  const releaseFirst = deferred();
  let writes = 0;
  const writer: ProjectWriter = {checkProjectConfigFile: f.writer.checkProjectConfigFile, writeProjectConfig: async (root, contents, signal) => {
    const index = ++writes;
    record(`write:${index}:start`);
    if (index === 1) {firstWrite.resolve();await releaseFirst.promise;}
    await f.writer.writeProjectConfig(root, contents, signal);
    record(`write:${index}:end`);
  }};
  return {writer, firstWrite: firstWrite.promise, release: releaseFirst.resolve};
};
// the editor's definitions with every load recorded by conversation once it completes
const recordingDefinitions = (f: Fixture, record: (event: string) => void): ProjectConfigDefinitions => ({...f.definitions,
  load: (...args) => f.definitions.load(...args).pipe(Effect.tap(() => Effect.sync(() => record(`load:${args[1]}`))))});
// the saves' locked bodies begin with their fresh load; the cancelled save c loads nothing after its initial load
const saveEvents = ["load:a", "load:a", "write:1:start", "load:b", "load:c", "load:d", "load:e", "write:1:end", "load:a", "load:b", "load:d", "load:e"];
const conflict = "The checkout or definition sources changed. Your draft was kept; refresh before saving again.";

const setup: ProjectDefinitionSetupInput = {origin: "project", action: "create", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"};
// each setup body's first native call is its branch read: the n-th read reports branch-n, so a setup's outcome names its turn; the first read waits for release
const numberedBranches = (f: Fixture, record: (event: string) => void) => {
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  const files: ProjectFiles = {...f.files, vcsInfo: async () => {
    const index = ++reads;
    record(`vcs:${index}`);
    if (index === 1) {entered.resolve();await release.promise;}
    return {isRepo: true, branch: `branch-${index}`, changedPaths: []};
  }};
  return {files, entered: entered.promise, release: release.resolve};
};
// the conversation's checkout read is the last step before a setup waits for its root's lock
const recordingProjection = (f: Fixture, record: (event: string) => void) => ({projection: (threadId: string) =>
  f.t3.projection(threadId).pipe(Effect.tap(() => Effect.sync(() => record(`projection:${threadId}`))))});
const staleAt = (turn: number) => ({status: "stale", workspaceRoot: "/workspace", branch: `branch-${turn}`, path: ".t3-supervisor",
  message: "The selected checkout branch changed. Reload checkout choices before setup."});

it("TR-ORDER-01: queued saves of one checkout run in arrival order around a cancelled caller, which expires, and the lock is released", {timeout: 10_000}, async () => {
  const f = indexedCheckout();
  const {events, record, recorded} = eventLog();
  const {writer, firstWrite, release} = heldWriter(f, record);
  const editor = f.editor(writer, recordingDefinitions(f, record));
  const revisions = new Map<string, string>();
  for (const thread of ["a", ...queued]) revisions.set(thread, (await f.loader.load("project", thread)).revision!);
  const first = editor.save(save("a", revisions.get("a")!));
  await within(firstWrite, 5_000, "first write");
  const cancels = new Map(queued.map(thread => [thread, new AbortController()]));
  const pending: Array<Promise<{status: string; message: string}>> = [];
  for (const thread of queued) {
    pending.push(editor.save(save(thread, revisions.get(thread)!), cancels.get(thread)!.signal));
    await within(recorded(`load:${thread}`), 5_000, `initial load ${thread}`);
    await loopTurn();
  }
  cancels.get("c")!.abort();
  await loopTurn();
  release();
  const outcomes = await within(Promise.all([first, ...pending]), 5_000, "queued saves");
  assert.deepEqual(events, saveEvents);
  assert.deepEqual(outcomes.map(outcome => [outcome.status, outcome.message]), [
    ["saved", "Saved .t3-supervisor/project.yaml. Required flags remain visible to the Supervisor for semantic review."],
    ["conflict", conflict], ["unavailable", "The save expired before writing. Refresh the project configuration."], ["conflict", conflict], ["conflict", conflict],
  ]);
  const later = await within(editor.save(save("f", (await f.loader.load("project", "f")).revision!)), 5_000, "later save");
  assert.equal(later.status, "saved", later.message);
  assert.equal(f.writes.length, 2);
});

it("TR-ORDER-02: queued setups of one checkout run in arrival order, a cancelled caller's included, and the lock is released", {timeout: 10_000}, async () => {
  const f = makeDefinitionFixture({threadRoot: null});
  const {events, record, recorded} = eventLog();
  const {files, entered, release} = numberedBranches(f, record);
  const loader = projectDefinitionsFacade(f.run, f.definitionsWith({files, t3: recordingProjection(f, record)}));
  const first = loader.initialize("project", "a", setup, AbortSignal.timeout(5_000));
  await within(entered, 5_000, "first setup body");
  const cancels = new Map(queued.map(thread => [thread, new AbortController()]));
  const pending: Array<Promise<unknown>> = [];
  for (const thread of queued) {
    pending.push(loader.initialize("project", thread, setup, cancels.get(thread)!.signal));
    await within(recorded(`projection:${thread}`), 5_000, `checkout read ${thread}`);
    await loopTurn();
  }
  cancels.get("c")!.abort();
  await loopTurn();
  release();
  const outcomes = await within(Promise.all([first, ...pending]), 5_000, "queued setups");
  assert.deepEqual(events, ["projection:a", "vcs:1", "projection:b", "projection:c", "projection:d", "projection:e", "vcs:2", "vcs:3", "vcs:4", "vcs:5"]);
  // the baseline lets a cancelled setup take its turn: its body reads the branch before any cancellation check
  assert.deepEqual(outcomes, [staleAt(1), staleAt(2), staleAt(3), staleAt(4), staleAt(5)]);
  assert.deepEqual(await within(loader.initialize("project", "f", setup, AbortSignal.timeout(5_000)), 5_000, "later setup"), staleAt(6));
});

it.effect("TR-ORDER-03: queued saves of one checkout run in arrival order around an interrupted fiber, which leaves the queue, and the lock is released", () => Effect.gen(function* () {
  const f = indexedCheckout();
  const {events, record, recorded} = eventLog();
  const {writer, firstWrite, release} = heldWriter(f, record);
  const editor = yield* ProjectConfigEditorService.make({writer: asProjectWriter(writer), definitions: recordingDefinitions(f, record)});
  const revisions = new Map<string, string>();
  for (const thread of ["a", ...queued]) revisions.set(thread, (yield* f.definitions.load("project", thread)).revision!);
  const first = yield* Effect.forkChild(editor.save(save("a", revisions.get("a")!)));
  yield* Effect.promise(() => firstWrite);
  const fibers = new Map<string, Fiber.Fiber<{status: string; message: string}, unknown>>();
  for (const thread of queued) {
    fibers.set(thread, yield* Effect.forkChild(editor.save(save(thread, revisions.get(thread)!))));
    yield* Effect.promise(() => recorded(`load:${thread}`));
  }
  yield* Fiber.interrupt(fibers.get("c")!);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(fibers.get("c")!)));
  release();
  const outcomes = [yield* Fiber.join(first), ...(yield* Effect.forEach(["b", "d", "e"], thread => Fiber.join(fibers.get(thread)!)))];
  assert.deepEqual(events, saveEvents);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ["saved", "conflict", "conflict", "conflict"]);
  const later = yield* editor.save(save("f", (yield* f.definitions.load("project", "f")).revision!));
  assert.equal(later.status, "saved", later.message);
  assert.equal(f.writes.length, 2);
}), {timeout: 10_000});

it.effect("TR-ORDER-04: queued setups of one checkout run in arrival order around an interrupted fiber, which never runs, and the lock is released", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  const {events, record, recorded} = eventLog();
  const {files, entered, release} = numberedBranches(f, record);
  const definitions = yield* ProjectDefinitions.make({source: f.source, t3: recordingProjection(f, record), files: asProjectFiles(files), options: asLoaderOptions(f.loaderOptions)});
  const first = yield* Effect.forkChild(definitions.initialize("project", "a", setup));
  yield* Effect.promise(() => entered);
  const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  for (const thread of queued) {
    fibers.set(thread, yield* Effect.forkChild(definitions.initialize("project", thread, setup)));
    yield* Effect.promise(() => recorded(`projection:${thread}`));
  }
  yield* Fiber.interrupt(fibers.get("c")!);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(fibers.get("c")!)));
  release();
  const outcomes = [yield* Fiber.join(first), ...(yield* Effect.forEach(["b", "d", "e"], thread => Fiber.join(fibers.get(thread)!)))];
  assert.deepEqual(events, ["projection:a", "vcs:1", "projection:b", "projection:c", "projection:d", "projection:e", "vcs:2", "vcs:3", "vcs:4"]);
  assert.deepEqual(outcomes, [staleAt(1), staleAt(2), staleAt(3), staleAt(4)]);
  assert.deepEqual(yield* definitions.initialize("project", "f", setup), staleAt(5));
}), {timeout: 10_000});
