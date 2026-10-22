import assert from "node:assert/strict";
import { it } from "vitest";
import { Effect } from "effect";
import type { ProjectDefinitions } from "../src/project-definitions.js";
import type { ProjectConfigSave } from "../src/project-definitions-contract.js";
import type { ProjectWriter } from "../src/project-files.js";
import { deferred, loopTurn, within } from "./support/c3b-http.js";
import { makeDefinitionFixture } from "./project-definitions-fixture.js";

const indexed = `workflows:
  - path: workflows/local-flow.yaml
    summary: Run the local flow.
steps:
  - path: steps/local-step.md
    summary: Check the local behavior.
`;

// a seeded checkout whose loader and writer record every load and write in order; the first write waits for release
const queuedEditor = () => {
  const f = makeDefinitionFixture();
  f.addFile(f.root, ".t3-supervisor/project.yaml", indexed);
  f.addFile(f.root, ".t3-supervisor/steps/local-step.md", "---\nid: local-step\nname: local-step\ndescription: Inspect the changed behavior.\n---\n");
  f.addFile(f.root, ".t3-supervisor/workflows/local-flow.yaml", "name: Local flow\ndescription: Local flow workflow.\nsequence:\n  - step: local-step\n");
  const events: string[] = [];
  const loaded: Array<() => void> = [];
  const loads = (count: number) => new Promise<void>(resolve => {
    const check = () => {if (events.filter(event => event === "load").length >= count) resolve();else loaded.push(check);};
    check();
  });
  const definitions = {...f.definitions,
    load: (...args: Parameters<ProjectDefinitions["Service"]["load"]>) => f.definitions.load(...args).pipe(Effect.tap(() => Effect.sync(() => {
      events.push("load");
      for (const waiter of loaded.splice(0)) waiter();
    }))),
  };
  const firstWrite = deferred();
  const releaseFirst = deferred();
  let writes = 0;
  const writer: ProjectWriter = {
    checkProjectConfigFile: f.writer.checkProjectConfigFile,
    writeProjectConfig: async (root, contents, signal) => {
      const index = ++writes;
      events.push(`write:${index}:start`);
      if (index === 1) {firstWrite.resolve();await releaseFirst.promise;}
      await f.writer.writeProjectConfig(root, contents, signal);
      events.push(`write:${index}:end`);
    },
  };
  return {f, editor: f.editor(writer, definitions), events, loads, firstWrite: firstWrite.promise, release: releaseFirst.resolve};
};

const input = (revision: string, summary: string): ProjectConfigSave => ({projectId: "project", threadId: null, expectedRevision: revision, config: {
  workflows: [{path: "workflows/local-flow.yaml", summary: "Run the local flow.", required: false}],
  steps: [{path: "steps/local-step.md", summary, required: false}],
}});

it("CT-EDITOR-01: two concurrent saves of one checkout with the same revision run one after another; the first saves and the second conflicts", {timeout: 10_000}, async () => {
  const {f, editor, events, loads, firstWrite, release} = queuedEditor();
  const revision = (await f.loader.load("project")).revision!;
  const first = editor.save(input(revision, "First draft."));
  await within(firstWrite, 5_000, "first write");
  const second = editor.save(input(revision, "Second draft."));
  // the second save's initial load completes; one loop turn later it waits behind the first save
  await within(loads(3), 5_000, "second initial load");
  await loopTurn();
  assert.deepEqual(events, ["load", "load", "write:1:start", "load"]);
  release();
  const [saved, conflict] = await within(Promise.all([first, second]), 5_000, "both saves");
  assert.equal(saved.status, "saved", saved.message);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.message, "The checkout or definition sources changed. Your draft was kept; refresh before saving again.");
  assert.equal(conflict.definitions?.revision, saved.definitions?.revision, "the conflict reports the definitions the first save produced");
  // the second save's fresh load happens only after the first save verified its write
  assert.deepEqual(events, ["load", "load", "write:1:start", "load", "write:1:end", "load", "load"]);
  assert.equal(f.writes.length, 1);
  assert.match(f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "", /First draft\./u);
});

it("CT-EDITOR-02: a save cancelled while queued behind another save waits its turn, reports the expired save and never writes", {timeout: 10_000}, async () => {
  const {f, editor, events, loads, firstWrite, release} = queuedEditor();
  const revision = (await f.loader.load("project")).revision!;
  const first = editor.save(input(revision, "First draft."));
  await within(firstWrite, 5_000, "first write");
  const cancel = new AbortController();
  let secondSettled = false;
  const second = editor.save(input(revision, "Cancelled draft."), cancel.signal).finally(() => {secondSettled = true;});
  await within(loads(3), 5_000, "second initial load");
  await loopTurn();
  cancel.abort();
  await loopTurn();
  assert.equal(secondSettled, false, "the cancelled save still waits for the save ahead of it");
  release();
  const [saved, expired] = await within(Promise.all([first, second]), 5_000, "both saves");
  assert.equal(saved.status, "saved", saved.message);
  assert.deepEqual(expired, {status: "unavailable", message: "The save expired before writing. Refresh the project configuration.", definitions: null});
  assert.deepEqual(events, ["load", "load", "write:1:start", "load", "write:1:end", "load"], "the cancelled save loaded nothing more and wrote nothing");
  assert.equal(f.writes.length, 1);
  assert.doesNotMatch(f.trees.get(f.root)?.get(".t3-supervisor/project.yaml") ?? "", /Cancelled draft/u);
});
