import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { ProjectConfigDefinitions, ProjectConfigWriter } from "../src/project-config-editor.js";
import type { ProjectDefinitions, ProjectDefinitionSetupInput } from "../src/project-definitions.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import type { ProjectFiles } from "../src/project-files.js";
import { within } from "./support/g5a-bounds.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

// target regression for the per-root locks: four saves and four setups queue behind a fifth on one checkout, the third
// arrival is cancelled, and the others run in arrival order as the baseline promise chain (022cbb5) ran them; a later
// operation on the same root completes, so every lock was released. conversations a..f all bind the registered root
// /workspace; the soft-cancel variants pass each caller's cancel signal to the service, the effect variants interrupt the fiber

type Fixture = ReturnType<typeof makeDefinitionFixture>;
type Record = (event: string) => Effect.Effect<void>;
const queued = ["b", "c", "d", "e"] as const;

// a recorded event log with a deferred per label, completed once that label is recorded. A completed deferred resumes its
// waiter on the recording fiber's stack, so a waiter yields once before acting, letting the recorder reach its lock wait as the
// baseline's promise hop did
const eventLog = () => {
  const events: string[] = [];
  const labels = new Map<string, Deferred.Deferred<void>>();
  const label = (event: string) => {
    const known = labels.get(event);
    if (known) return known;
    const created = Deferred.makeUnsafe<void>();
    labels.set(event, created);
    return created;
  };
  const record: Record = event => Effect.sync(() => events.push(event)).pipe(Effect.andThen(Deferred.succeed(label(event), undefined)), Effect.asVoid);
  const recorded = (event: string) => Deferred.await(label(event));
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
const heldWriter = (f: Fixture, record: Record) => {
  const firstWrite = Deferred.makeUnsafe<void>();
  const releaseFirst = Deferred.makeUnsafe<void>();
  let writes = 0;
  const writer: ProjectConfigWriter = {checkProjectConfigFile: f.projectWriter.checkProjectConfigFile, writeProjectConfig: (root, contents) => Effect.gen(function* () {
    const index = ++writes;
    yield* record(`write:${index}:start`);
    if (index === 1) {yield* Deferred.succeed(firstWrite, undefined);yield* Deferred.await(releaseFirst);}
    yield* f.projectWriter.writeProjectConfig(root, contents);
    yield* record(`write:${index}:end`);
  })};
  return {writer, firstWrite: Deferred.await(firstWrite), release: Deferred.succeed(releaseFirst, undefined)};
};
// the editor's definitions with every load recorded by conversation once it completes
const recordingDefinitions = (definitions: ProjectDefinitions["Service"], record: Record): ProjectConfigDefinitions => ({...definitions,
  load: (...args) => definitions.load(...args).pipe(Effect.tap(() => record(`load:${args[1]}`)))});
// the saves' locked bodies begin with their fresh load; the cancelled save c loads nothing after its initial load
const saveEvents = ["load:a", "load:a", "write:1:start", "load:b", "load:c", "load:d", "load:e", "write:1:end", "load:a", "load:b", "load:d", "load:e"];
const conflict = "The checkout or definition sources changed. Your draft was kept; refresh before saving again.";

const setup: ProjectDefinitionSetupInput = {origin: "project", action: "create", expectedWorkspaceRoot: "/workspace", expectedBranch: "main"};
// each setup body's first native call is its branch read: the n-th read reports branch-n, so a setup's outcome names its turn; the first read waits for release
const numberedBranches = (f: Fixture, record: Record) => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let reads = 0;
  const files: ProjectFiles["Service"] = {...f.projectFiles, vcsInfo: () => Effect.gen(function* () {
    const index = ++reads;
    yield* record(`vcs:${index}`);
    if (index === 1) {yield* Deferred.succeed(entered, undefined);yield* Deferred.await(release);}
    return {isRepo: true, branch: `branch-${index}`, changedPaths: []};
  })};
  return {files, entered: Deferred.await(entered), release: Deferred.succeed(release, undefined)};
};
// the conversation's checkout read is the last step before a setup waits for its root's lock
const recordingProjection = (f: Fixture, record: Record) => ({projection: (threadId: string) =>
  f.t3.projection(threadId).pipe(Effect.tap(() => record(`projection:${threadId}`)))});
const staleAt = (turn: number) => ({status: "stale", workspaceRoot: "/workspace", branch: `branch-${turn}`, path: ".t3-supervisor",
  message: "The selected checkout branch changed. Reload checkout choices before setup."});

it.effect("TR-ORDER-01: queued saves of one checkout run in arrival order around a cancelled caller, which expires, and the lock is released", () => Effect.gen(function* () {
  const f = indexedCheckout();
  const {events, record, recorded} = eventLog();
  const {writer, firstWrite, release} = heldWriter(f, record);
  const definitions = yield* f.makeDefinitions();
  const editor = yield* f.makeConfigEditor(recordingDefinitions(definitions, record), writer);
  const revisions = new Map<string, string>();
  for (const thread of ["a", ...queued]) revisions.set(thread, (yield* definitions.load("project", thread)).revision!);
  const first = yield* Effect.forkChild(editor.save(save("a", revisions.get("a")!)));
  yield* within(firstWrite, 5_000, "first write");
  // each queued caller's cancel signal is the editor's soft cancellation: a cancelled save reports the expired save in its turn
  const cancels = new Map(queued.map(thread => [thread, new AbortController()]));
  const pending: Array<Fiber.Fiber<{status: string; message: string}, unknown>> = [];
  for (const thread of queued) {
    pending.push(yield* Effect.forkChild(editor.save(save(thread, revisions.get(thread)!), cancels.get(thread)!.signal)));
    yield* within(recorded(`load:${thread}`), 5_000, `initial load ${thread}`);
    yield* Effect.yieldNow;
  }
  cancels.get("c")!.abort();
  yield* Effect.yieldNow;
  yield* release;
  const outcomes = yield* within(Fiber.joinAll([first, ...pending]), 5_000, "queued saves");
  assert.deepEqual(events, saveEvents);
  assert.deepEqual(outcomes.map(outcome => [outcome.status, outcome.message]), [
    ["saved", "Saved .t3-supervisor/project.yaml. Required flags remain visible to the Supervisor for semantic review."],
    ["conflict", conflict], ["unavailable", "The save expired before writing. Refresh the project configuration."], ["conflict", conflict], ["conflict", conflict],
  ]);
  const later = yield* within(editor.save(save("f", (yield* definitions.load("project", "f")).revision!)), 5_000, "later save");
  assert.equal(later.status, "saved", later.message);
  assert.equal(f.writes.length, 2);
}), {timeout: 10_000});

it.effect("TR-ORDER-02: queued setups of one checkout run in arrival order, a cancelled caller's included, and the lock is released", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  const {events, record, recorded} = eventLog();
  const {files, entered, release} = numberedBranches(f, record);
  const definitions = yield* f.makeDefinitions({files, t3: recordingProjection(f, record)});
  const first = yield* Effect.forkChild(definitions.initialize("project", "a", setup));
  yield* within(entered, 5_000, "first setup body");
  // each queued caller's cancel signal is the setup's soft cancellation, checked only once its body runs
  const cancels = new Map(queued.map(thread => [thread, new AbortController()]));
  const pending: Array<Fiber.Fiber<unknown, unknown>> = [];
  for (const thread of queued) {
    pending.push(yield* Effect.forkChild(definitions.initialize("project", thread, setup, cancels.get(thread)!.signal)));
    yield* within(recorded(`projection:${thread}`), 5_000, `checkout read ${thread}`);
    yield* Effect.yieldNow;
  }
  cancels.get("c")!.abort();
  yield* Effect.yieldNow;
  yield* release;
  const outcomes = yield* within(Fiber.joinAll([first, ...pending]), 5_000, "queued setups");
  assert.deepEqual(events, ["projection:a", "vcs:1", "projection:b", "projection:c", "projection:d", "projection:e", "vcs:2", "vcs:3", "vcs:4", "vcs:5"]);
  // the baseline lets a cancelled setup take its turn: its body reads the branch before any cancellation check
  assert.deepEqual(outcomes, [staleAt(1), staleAt(2), staleAt(3), staleAt(4), staleAt(5)]);
  assert.deepEqual(yield* within(definitions.initialize("project", "f", setup), 5_000, "later setup"), staleAt(6));
}), {timeout: 10_000});

it.effect("TR-ORDER-03: queued saves of one checkout run in arrival order around an interrupted fiber, which leaves the queue, and the lock is released", () => Effect.gen(function* () {
  const f = indexedCheckout();
  const {events, record, recorded} = eventLog();
  const {writer, firstWrite, release} = heldWriter(f, record);
  const definitions = yield* f.makeDefinitions();
  const editor = yield* f.makeConfigEditor(recordingDefinitions(definitions, record), writer);
  const revisions = new Map<string, string>();
  for (const thread of ["a", ...queued]) revisions.set(thread, (yield* definitions.load("project", thread)).revision!);
  const first = yield* Effect.forkChild(editor.save(save("a", revisions.get("a")!)));
  yield* firstWrite;
  const fibers = new Map<string, Fiber.Fiber<{status: string; message: string}, unknown>>();
  for (const thread of queued) {
    fibers.set(thread, yield* Effect.forkChild(editor.save(save(thread, revisions.get(thread)!))));
    yield* recorded(`load:${thread}`);
    yield* Effect.yieldNow;
  }
  yield* Fiber.interrupt(fibers.get("c")!);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(fibers.get("c")!)));
  yield* release;
  const outcomes = [yield* Fiber.join(first), ...(yield* Effect.forEach(["b", "d", "e"], thread => Fiber.join(fibers.get(thread)!)))];
  assert.deepEqual(events, saveEvents);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ["saved", "conflict", "conflict", "conflict"]);
  const later = yield* editor.save(save("f", (yield* definitions.load("project", "f")).revision!));
  assert.equal(later.status, "saved", later.message);
  assert.equal(f.writes.length, 2);
}), {timeout: 10_000});

it.effect("TR-ORDER-04: queued setups of one checkout run in arrival order around an interrupted fiber, which never runs, and the lock is released", () => Effect.gen(function* () {
  const f = makeDefinitionFixture({threadRoot: null});
  const {events, record, recorded} = eventLog();
  const {files, entered, release} = numberedBranches(f, record);
  const definitions = yield* f.makeDefinitions({files, t3: recordingProjection(f, record)});
  const first = yield* Effect.forkChild(definitions.initialize("project", "a", setup));
  yield* entered;
  const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  for (const thread of queued) {
    fibers.set(thread, yield* Effect.forkChild(definitions.initialize("project", thread, setup)));
    yield* recorded(`projection:${thread}`);
    yield* Effect.yieldNow;
  }
  yield* Fiber.interrupt(fibers.get("c")!);
  assert.ok(Exit.hasInterrupts(yield* Fiber.await(fibers.get("c")!)));
  yield* release;
  const outcomes = [yield* Fiber.join(first), ...(yield* Effect.forEach(["b", "d", "e"], thread => Fiber.join(fibers.get(thread)!)))];
  assert.deepEqual(events, ["projection:a", "vcs:1", "projection:b", "projection:c", "projection:d", "projection:e", "vcs:2", "vcs:3", "vcs:4"]);
  assert.deepEqual(outcomes, [staleAt(1), staleAt(2), staleAt(3), staleAt(4)]);
  assert.deepEqual(yield* definitions.initialize("project", "f", setup), staleAt(5));
}), {timeout: 10_000});
