import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import type { ProjectConfigWriter } from "../src/project-config-editor.js";
import type { ProjectDefinitions } from "../src/project-definitions.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import { within } from "./support/g5a-bounds.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

const indexed = `workflows:
  - path: workflows/local-flow.yaml
    summary: Run the local flow.
steps:
  - path: steps/local-step.md
    summary: Check the local behavior.
`;

// a seeded checkout whose definitions and writer record every load and write in order; the first write waits for release; the
// definitions and editor live in the test's scope, and the unrecorded definitions answer the test's own revision read
const queuedEditor = Effect.gen(function* () {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", indexed);
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: local-step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  const events: string[] = [];
  // the n-th recorded load completes the deferred of count n, so loads(count) resumes once that many loads were recorded
  const reached = new Map<number, Deferred.Deferred<void>>();
  const counted = (count: number) => {
    const known = reached.get(count);
    if (known) return known;
    const created = Deferred.makeUnsafe<void>();
    reached.set(count, created);
    return created;
  };
  const loads = (count: number) => Deferred.await(counted(count));
  const definitions = yield* f.makeDefinitions();
  const recorded: ProjectDefinitions["Service"] = {...definitions,
    load: (...args) => definitions.load(...args).pipe(Effect.tap(() => Effect.suspend(() => {
      events.push("load");
      return Deferred.succeed(counted(events.filter(event => event === "load").length), undefined);
    }))),
  };
  const firstWrite = Deferred.makeUnsafe<void>();
  const releaseFirst = Deferred.makeUnsafe<void>();
  let writes = 0;
  const writer: ProjectConfigWriter = {
    checkProjectConfigFile: f.projectWriter.checkProjectConfigFile,
    writeProjectConfig: (root, contents) => Effect.gen(function* () {
      const index = ++writes;
      events.push(`write:${index}:start`);
      if (index === 1) {yield* Deferred.succeed(firstWrite, undefined);yield* Deferred.await(releaseFirst);}
      yield* f.projectWriter.writeProjectConfig(root, contents);
      events.push(`write:${index}:end`);
    }),
  };
  return {f, definitions, editor: yield* f.makeConfigEditor(recorded, writer), events, loads, firstWrite: Deferred.await(firstWrite),
    release: Deferred.succeed(releaseFirst, undefined)};
});

const input = (revision: string, summary: string): ProjectConfigSave => ({projectId: "project", threadId: null, expectedRevision: revision, config: {
  workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
  steps: [{path: "steps/local-step.md", summary, required: false}],
}});

it.effect("CT-EDITOR-01: two concurrent saves of one checkout with the same revision run one after another; the first saves and the second conflicts", () => Effect.gen(function* () {
  const {f, definitions, editor, events, loads, firstWrite, release} = yield* queuedEditor;
  const revision = (yield* definitions.load("project")).revision!;
  const first = yield* Effect.forkChild(editor.save(input(revision, "First draft.")));
  yield* within(firstWrite, 5_000, "first write");
  const second = yield* Effect.forkChild(editor.save(input(revision, "Second draft.")));
  // the second save's initial load completes; one yield later it waits behind the first save
  yield* within(loads(3), 5_000, "second initial load");
  yield* Effect.yieldNow;
  assert.deepEqual(events, ["load", "load", "write:1:start", "load"]);
  yield* release;
  const [saved, conflict] = yield* within(Effect.all([Fiber.join(first), Fiber.join(second)]), 5_000, "both saves");
  assert.equal(saved.status, "saved", saved.message);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.message, "The checkout or definition sources changed. Your draft was kept; refresh before saving again.");
  assert.equal(conflict.definitions?.revision, saved.definitions?.revision, "the conflict reports the definitions the first save produced");
  // the second save's fresh load happens only after the first save verified its write
  assert.deepEqual(events, ["load", "load", "write:1:start", "load", "write:1:end", "load", "load"]);
  assert.equal(f.writes.length, 1);
  assert.match(f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "", /First draft\./u);
}), {timeout: 10_000});

it.effect("CT-EDITOR-02: a save cancelled while queued behind another save waits its turn, reports the expired save and never writes", () => Effect.gen(function* () {
  const {f, definitions, editor, events, loads, firstWrite, release} = yield* queuedEditor;
  const revision = (yield* definitions.load("project")).revision!;
  const first = yield* Effect.forkChild(editor.save(input(revision, "First draft.")));
  yield* within(firstWrite, 5_000, "first write");
  // the caller's cancel trigger is the editor's soft cancellation: a cancelled save reports the expired save in its turn
  const cancel = yield* Deferred.make<void>();
  let secondSettled = false;
  const second = yield* Effect.forkChild(editor.save(input(revision, "Cancelled draft."), cancel).pipe(Effect.ensuring(Effect.sync(() => {secondSettled = true;}))));
  yield* within(loads(3), 5_000, "second initial load");
  yield* Effect.yieldNow;
  yield* Deferred.succeed(cancel, undefined);
  yield* Effect.yieldNow;
  assert.equal(secondSettled, false, "the cancelled save still waits for the save ahead of it");
  yield* release;
  const [saved, expired] = yield* within(Effect.all([Fiber.join(first), Fiber.join(second)]), 5_000, "both saves");
  assert.equal(saved.status, "saved", saved.message);
  assert.deepEqual(expired, {status: "unavailable", message: "The save expired before writing. Refresh the project configuration.", definitions: null});
  assert.deepEqual(events, ["load", "load", "write:1:start", "load", "write:1:end", "load"], "the cancelled save loaded nothing more and wrote nothing");
  assert.equal(f.writes.length, 1);
  assert.doesNotMatch(f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "", /Cancelled draft/u);
}), {timeout: 10_000});
