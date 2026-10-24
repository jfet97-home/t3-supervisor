import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {Effect} from "effect";
import {AtomRegistry} from "effect/reactivity";
import {ProjectFileError} from "../src/project-files.js";
import {ProjectDefinitions} from "../src/project-definitions.js";
import {branchLabel, CheckoutChooser, orphanedConversations} from "../ui/src/checkout-identity.js";
import {HelpDisclosure, EntityDetails} from "../ui/src/disclosure.js";
import {DefinitionsContent} from "../ui/src/project-definitions.js";
import {configurationDrafts, configurationScope} from "../ui/src/project-configuration-editor.js";
import {GlobalSupervisionStatus, ProjectSupervisionStatus} from "../ui/src/supervision-status.js";
import {conversationLabel} from "../ui/src/conversation-status.js";
import {makeDefinitionFixture} from "./project-definitions-fixture.js";
import {FixtureModel, fixtureIds} from "./ui-fixture/scenarios.js";

it.effect("checkout inventory groups normalized folders, preserves every working copy and trusts only native branch facts", () => Effect.gen(function*() {
  const f = makeDefinitionFixture();
  const paths = [null, null, null, "/worktrees/feature", "/worktrees/feature/.", "/worktrees/no-branch"];
  const threads = paths.map((_, i) => ({id: `chat-${i}`, projectId: f.projectId, title: i === 5 ? "branch-looking-title" : `Chat ${i}`, lineage: {parentThreadId: null, relationshipToParent: null}}));
  const definitions = yield* ProjectDefinitions.make({source: {catalog: () => Effect.succeed({projects: [{project: {id: f.projectId, title: "Project", workspaceRoot: f.root}, available: true}], threads})},
    t3: {projection: id => Effect.succeed({snapshotSequence: 1, projection: {thread: {...threads.find(thread => thread.id === id)!, worktreePath: paths[Number(id.split("-")[1])]}, runs: [], messages: []}})},
    files: {...f.projectFiles, vcsInfo: path => Effect.succeed({isRepo: true, branch: path.endsWith("no-branch") ? null : path === f.root ? "main" : "feature", changedPaths: []})}, options: f.definitionOptions});
  const targets = yield* definitions.checkoutTargets(f.projectId);
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.find(target => target.workspaceRoot === f.root)!.members.map(member => member.threadId), ["chat-0", "chat-1", "chat-2"]);
  assert.equal(targets.find(target => target.workspaceRoot === "/worktrees/feature")!.members.length, 2);
  assert.equal(targets.find(target => target.workspaceRoot === "/worktrees/no-branch")!.branch, null);
  assert.equal(branchLabel({...targets.find(target => target.workspaceRoot.endsWith("no-branch"))!, vcsAvailable: true}), "Git branch undetected");
}));

it("working-folder failures are explicit and never fall back to a chat-title chooser", () => {
  const html = renderToStaticMarkup(createElement(CheckoutChooser, {inventory: {projectId: "p", available: false, complete: false, defaultBranch: null, issues: [], reason: "workspace_binding_unavailable", targets: []}, selected: null, disabled: false, onRefresh: () => {}, onSelect: () => {}}));
  assert.match(html, /workspace_binding_unavailable/);
  assert.doesNotMatch(html, /checkout-target|branch-looking-title/);
  assert.equal(branchLabel({branch: null, isGitRepository: false, vcsAvailable: true}), "Git branch undetected");
});

it("catalog bounds a long collection and exposes full template duties only in the selected detail", () => {
  const model = new FixtureModel(); model.setLargeInterface();
  const definitions = model.projectDefinitions(fixtureIds.projectA, null);
  const catalog = renderToStaticMarkup(createElement(DefinitionsContent, {definitions}));
  assert.equal((catalog.match(/class="catalog-row"/g) ?? []).length, 25);
  assert.match(catalog, /1–25 of 48/);
  assert.doesNotMatch(catalog, /Definition source files|Preserve the actual scope/);
  const detail = renderToStaticMarkup(createElement(DefinitionsContent, {definitions, selectedDefinition: "step:fixture-duty-45"}));
  assert.match(detail, /Preserve the actual scope/);
  assert.match(detail, /synthetic-reference/);
  assert.doesNotMatch(detail, /class="catalog-row"/);
});

it("shared-folder drafts retain their admitted operation across different chat identities", () => {
  const model = new FixtureModel();
  const a = model.projectDefinitions(fixtureIds.projectA, fixtureIds.threadA1);
  const b = model.projectDefinitions(fixtureIds.projectA, fixtureIds.threadA2);
  const registry = AtomRegistry.make();
  try {
    const first = configurationDrafts(configurationScope("env", a));
    registry.set(first, {...registry.get(first), editing: true, operationId: "same-admitted-save", config: {...a.projectConfig!, default_workflow: "changed"}});
    const second = configurationDrafts(configurationScope("env", b));
    assert.equal(registry.get(second).operationId, "same-admitted-save");
    assert.equal(registry.get(second).config!.default_workflow, "changed");
    assert.notEqual(configurationScope("env", a), configurationScope("env", {...b, workspaceRoot: "/another-folder"}));
  } finally {registry.dispose();}
});

it("help and entity disclosures preserve native semantics with a compact explicit cue", () => {
  for (const component of [HelpDisclosure, EntityDetails]) {
    const html = renderToStaticMarkup(createElement(component, {title: "Scoped details", children: "Body"}));
    assert.match(html, /<details/); assert.match(html, /<summary>/);
    assert.match(html, /disclosure-cue/); assert.match(html, /disclosure-body/);
    assert.doesNotMatch(html, /tabindex="[1-9]|<summary>[^]*<button/);
  }
});

it("global, project and conversation labels keep independent truth and explicit disable semantics", () => {
  const global = renderToStaticMarkup(createElement(GlobalSupervisionStatus, {enabled: true}));
  const project = renderToStaticMarkup(createElement(ProjectSupervisionStatus, {enabled: false, effectiveEnabled: false, globallyEnabled: true, available: true}));
  assert.match(global, /Global supervision: On/); assert.match(project, /Project supervision: Off/);
  const blocked = renderToStaticMarkup(createElement(ProjectSupervisionStatus, {enabled: true, effectiveEnabled: false, globallyEnabled: false, available: true}));
  assert.match(blocked, /global supervision is off/);
  assert.match(conversationLabel({mode: "engaged", availability: "current", consideredAt: null})!, /Engaged/);
  assert.match(conversationLabel({mode: "following", availability: "stopped", consideredAt: null})!, /disabled/);
  assert.match(conversationLabel({mode: "following", availability: "stopped", consideredAt: null}, true, true)!, /stopped/);
});

it.effect("read-only inventory retains an independent root when a conversation binding is unreadable, while setup and chat loading stay strict", () => Effect.gen(function*() {
  const f = makeDefinitionFixture();
  const definitions = yield* f.makeDefinitions({t3: {projection: id => f.t3.projection(id).pipe(Effect.map(value => ({...value, projection: {...value.projection, thread: {...value.projection.thread, worktreePath: undefined}}})))}});
  const inventory = yield* definitions.checkoutInventory(f.projectId);
  assert.equal(inventory.available, true); assert.equal(inventory.complete, false);
  assert.equal(inventory.targets.length, 1); assert.equal(inventory.targets[0]!.workspaceRoot, f.root);
  assert.equal(inventory.targets[0]!.members.length, 0, "an unread conversation is not counted as a shared-root member");
  assert.match(inventory.issues[0]!.message, /has not been established by T3/);
  const strict = yield* Effect.flip(definitions.checkoutTargets(f.projectId));
  assert.equal(strict._tag, "DefinitionCheckoutUnavailable");
  assert.equal(yield* definitions.currentWorkspace(f.projectId, "thread"), null, "missing conversation binding must never substitute the root");
}));


it.effect("missing worktrees orphan only their retained chats; denied access never does, and no Git facts are read for missing paths", () => Effect.gen(function*() {
  const f = makeDefinitionFixture();
  const gitReads: string[] = [];
  const definitions = yield* f.makeDefinitions({files: {...f.projectFiles,
    directoryExists: root => root === f.threadRoot ? Effect.succeed(false) : f.projectFiles.directoryExists(root),
    vcsInfo: root => Effect.sync(() => {gitReads.push(root);return {isRepo: true, branch: "feature"};})}});
  const inventory = yield* definitions.checkoutInventory(f.projectId);
  const missing = inventory.targets.find(target => target.workspaceRoot === f.threadRoot)!;
  assert.equal(missing.presence, "missing"); assert.equal(missing.branch, null); assert.equal(missing.vcsAvailable, false);
  assert.ok(!gitReads.includes(f.threadRoot!));
  assert.equal(orphanedConversations(inventory).get("thread"), f.threadRoot);
  const html = renderToStaticMarkup(createElement(CheckoutChooser, {inventory, selected: null, disabled: false, onRefresh: () => {}, onSelect: () => {}}));
  assert.match(html, /Folder missing/); assert.match(html, /Orphaned chats/);
  assert.doesNotMatch(html, /Not a Git repository/);
  const denied = yield* f.makeDefinitions({files: {...f.projectFiles, directoryExists: root => root === f.threadRoot ? Effect.fail(new ProjectFileError("permission_required")) : f.projectFiles.directoryExists(root)}});
  const unreadable = yield* denied.checkoutInventory(f.projectId);
  assert.equal(unreadable.targets.find(target => target.workspaceRoot === f.threadRoot)!.presence, "unavailable");
  assert.equal(orphanedConversations(unreadable).size, 0); assert.equal(unreadable.complete, false);
}));

it.effect("the project folder and Git-reported trunk checkout are distinct, deduplicated and independently readable without a conversation binding", () => Effect.gen(function*() {
  const f = makeDefinitionFixture(); const trunk = "/worktrees/trunk";
  f.writeIndex(trunk);
  const definitions = yield* f.makeDefinitions({files: {...f.projectFiles, vcsInfo: root => Effect.succeed({isRepo: true, branch: root === trunk ? "trunk" : "release",
    refs: [{name: "trunk", current: false, isDefault: true, worktreePath: trunk}, {name: "release", current: true, isDefault: false, worktreePath: f.root}]})}});
  const inventory = yield* definitions.checkoutInventory(f.projectId);
  assert.equal(inventory.defaultBranch, "trunk");
  assert.equal(inventory.targets.filter(target => target.isProjectFolder).length, 1);
  assert.equal(inventory.targets.find(target => target.isProjectFolder)!.branch, "release");
  assert.equal(inventory.targets.filter(target => target.isDefaultBranch).length, 1);
  assert.equal(inventory.targets.find(target => target.isDefaultBranch)!.workspaceRoot, trunk);
  assert.equal((yield* definitions.load(f.projectId, null, undefined, trunk)).workspaceRoot, trunk);
  const invalid = yield* definitions.load(f.projectId, null, undefined, "/unregistered-path");
  assert.equal(invalid.status, "unavailable"); assert.equal(invalid.workspaceRoot, "");
  const combined = yield* f.makeDefinitions({files: {...f.projectFiles, vcsInfo: root => Effect.succeed({isRepo: true, branch: root === f.root ? "trunk" : "feature",
    refs: [{name: "trunk", current: true, isDefault: true, worktreePath: f.root}]})}});
  const same = yield* combined.checkoutInventory(f.projectId);
  assert.equal(same.targets.filter(target => target.isProjectFolder || target.isDefaultBranch).length, 1);
  const html = renderToStaticMarkup(createElement(CheckoutChooser, {inventory: same, selected: null, disabled: false, onRefresh: () => {}, onSelect: () => {}}));
  assert.equal((html.match(/checkout-prominent/g) ?? []).length, 1);
  assert.match(html, /Project folder/); assert.match(html, /Default branch trunk/);
}));
