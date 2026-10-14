import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Schema } from "effect";
import { SupervisionSetup, type SupervisionSetupInput } from "../src/supervisor-control-contract.js";
import { buildSupervisionSetupIntent, GlobalDefinitionsControlView, SupervisionControlView, SupervisionSetupView } from "../ui/src/supervisor-control.js";

test("the master switch and shared definition switch explain their separate effects", () => {
  const handlers = {busy: false, blocked: false, message: "", onToggle: () => {}, onReload: () => {}};
  const master = renderToStaticMarkup(createElement(SupervisionControlView, {...handlers,
    control: {projectId: null, generation: 0, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true, detectionStatus: "not_checked", detectionError: null}}));
  assert.match(master, /master switch.*starts enabled/);
  assert.match(master, /Disable supervision/);
  const definitions = renderToStaticMarkup(createElement(GlobalDefinitionsControlView, {...handlers,
    control: {generation: 0, enabled: false, manual: false, effectiveEnabled: false, detectionStatus: "missing", detectionError: null, homePath: "~/.t3-supervisor"}}));
  assert.match(definitions, /This starts disabled/);
  assert.match(definitions, /~\/.t3-supervisor/);
  assert.match(definitions, /files are left uncommitted/);
  assert.match(definitions, /Enable global definitions/);
});

test("setup keeps the two creation actions for a selected checkout with no definitions", () => {
  const checkout = {threadId: "main-a", workspaceRoot: "/work/feature-a", branch: "feature-a", isGitRepository: true, folderStatus: "missing" as const, origin: "project" as const};
  const options = {projectId: "p", generation: 1, available: true, message: "Choose where to create definitions.", checkouts: [checkout]};
  const handlers = {options, busy: false, blocked: false, message: "", onSelect: () => {}, onSetup: () => {}, onReload: () => {}};
  const unselected = renderToStaticMarkup(createElement(SupervisionSetupView, {...handlers, selected: ""}));
  assert.match(unselected, /disabled="">Create<\/button>/);
  const selected = renderToStaticMarkup(createElement(SupervisionSetupView, {...handlers, selected: JSON.stringify([checkout.threadId, checkout.workspaceRoot])}));
  assert.match(selected, /\/work\/feature-a\/.t3-supervisor/);
  assert.match(selected, /Branch: <strong>feature-a/);
  assert.match(selected, />Create<\/button>/);
  assert.match(selected, />Create \+ commit<\/button>/);
  assert.match(selected, /Create leaves files uncommitted/);
  assert.match(selected, /Repository hooks and signing apply/);
  assert.match(selected, /hooks can alter committed contents, and failure can leave files staged/);
  assert.doesNotMatch(selected, /Enable existing definitions/);
});

test("a selected worktree with existing definitions offers an explicit no-write enable action", () => {
  const checkout = {threadId: "main-worktree", workspaceRoot: "/worktrees/feature-a", branch: "feature-a", isGitRepository: true, folderStatus: "present" as const, origin: "project" as const};
  const options = {projectId: "project-a", generation: 7, available: true, message: "Choose a checkout.", checkouts: [checkout]};
  const selected = renderToStaticMarkup(createElement(SupervisionSetupView, {options, selected: JSON.stringify([checkout.threadId, checkout.workspaceRoot]),
    busy: false, blocked: false, message: "", onSelect: () => {}, onSetup: () => {}, onReload: () => {}}));
  assert.match(selected, /\/worktrees\/feature-a\/\.t3-supervisor/);
  assert.match(selected, /Branch: <strong>feature-a/);
  assert.match(selected, /This enables supervision using those files; no files will be written or committed/);
  assert.match(selected, />Enable existing definitions<\/button>/);
  assert.match(selected, /disabled="">Create<\/button>/);
  assert.match(selected, /disabled="">Create \+ commit<\/button>/);
});

test("the existing-worktree enable request preserves the selected checkout in the parsed contract", () => {
  const checkout = {threadId: "main-worktree", workspaceRoot: "/worktrees/feature-a", branch: "feature-a", isGitRepository: true, folderStatus: "present" as const, origin: "project" as const};
  const intent = buildSupervisionSetupIntent("project-a", 7, checkout, "enable_existing");
  const parsed = Schema.decodeUnknownSync(SupervisionSetup)(intent);
  const expected: SupervisionSetupInput = {
    projectId: "project-a", expectedGeneration: 7, origin: "project", threadId: "main-worktree",
    expectedWorkspaceRoot: "/worktrees/feature-a", expectedBranch: "feature-a", action: "enable_existing",
  };
  assert.deepEqual(parsed, expected);
  assert.throws(() => Schema.decodeUnknownSync(SupervisionSetup)({...intent, action: "enable"}));
});
