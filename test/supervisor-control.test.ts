import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import type { SupervisorBaseline, SupervisionFolderPresence } from "../src/project-supervisor-store.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { T3TransportError } from "../src/t3.js";
import { requiredReferences, type ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { ProjectInfo, Projection, ThreadInfo } from "../src/types.js";
import { makeDefinitionFixture, stepSource } from "./project-definitions-fixture.js";
import { dataDirectory, nativeClient, openStores, realTime, type ConversationStores, type ProjectionRead } from "./support/g1a-conversation.js";
import { execute, query } from "./support/g1b-conversation.js";
import { asRpcBaseline, ctlSupervisor, type CtlDefinitionOps } from "./support/ctl-supervisor.js";
import type { StoreShape } from "../src/store.js";

const baseline = (latestRunId: string | null = null): SupervisorBaseline => ({version: 2, snapshotSequence: 20,
  threads: latestRunId ? [{id: "main", latestRunId}] : []});

const project: ProjectInfo = {id: "project-a", title: "Project A", workspaceRoot: "/work/project-a"};

const makeProjectSupervisor = (stores: ConversationStores, overrides: {
  presence?: CtlDefinitionOps["presence"];
  presenceGlobal?: CtlDefinitionOps["presenceGlobal"];
  globalFingerprint?: CtlDefinitionOps["globalFingerprint"];
  initializeGlobal?: CtlDefinitionOps["initializeGlobal"];
  checkoutTargets?: CtlDefinitionOps["checkoutTargets"];
  presenceForCheckout?: CtlDefinitionOps["presenceForCheckout"];
  initialize?: CtlDefinitionOps["initialize"];
  activation?: () => Effect.Effect<SupervisorBaseline, unknown>;
  catalog?: StoreShape["catalog"];
  projection?: ProjectionRead;
} = {}) => {
  const definitions: CtlDefinitionOps = {
    load: () => Effect.fail(new Error("unexpected definition load")),
    globalDefinitionsPath: () => "~/.t3-supervisor",
    ...(overrides.presence ? {presence: overrides.presence} : {}),
    ...(overrides.presenceGlobal ? {presenceGlobal: overrides.presenceGlobal} : {}),
    ...(overrides.globalFingerprint ? {globalFingerprint: overrides.globalFingerprint} : {}),
    ...(overrides.initializeGlobal ? {initializeGlobal: overrides.initializeGlobal} : {}),
    ...(overrides.checkoutTargets ? {checkoutTargets: overrides.checkoutTargets} : {}),
    ...(overrides.presenceForCheckout ? {presenceForCheckout: overrides.presenceForCheckout} : {}),
    ...(overrides.initialize ? {initialize: overrides.initialize} : {}),
  };
  return ctlSupervisor({
    stores,
    catalog: overrides.catalog ?? (() => Effect.succeed({projects: [{project, available: true}], threads: [] as ThreadInfo[]})),
    projection: overrides.projection ?? (() => Effect.fail(new T3TransportError("unexpected projection"))),
    read: nativeClient(() => {throw new Error("unexpected read");}),
    operate: null,
    baseline: asRpcBaseline(overrides.activation ?? (() => Effect.succeed(baseline()))),
    definitions,
  });
};

const withStores = <A, E, R>(work: (stores: ConversationStores) => Effect.Effect<A, E, R>) => Effect.gen(function* () {
  yield* realTime;
  const directory = yield* dataDirectory("supervisor-control-");
  const stores = yield* openStores(directory, directory);
  return yield* work(stores);
});

const scopedDefinitionSnapshot = (globalEnabled: boolean, scratch = false, snapshotProjectId = "project-a", root = "/work/project-a") => Effect.gen(function* () {
  const fixture = makeDefinitionFixture({projectId: snapshotProjectId, root, threadRoot: root, globalEnabled, scratch});
  fixture.addFile(root, ".t3-supervisor/steps/local-check.md", stepSource("local-check", "Verify local behavior."));
  fixture.addDirectory(root, ".t3-supervisor/workflows");
  fixture.writeIndex(root, {required: [{step: "local-check"}]});
  fixture.addFile(fixture.globalRoot, ".t3-supervisor/steps/global-check.md", stepSource("global-check", "Verify shared behavior."));
  fixture.addDirectory(fixture.globalRoot, ".t3-supervisor/workflows");
  fixture.writeIndex(fixture.globalRoot, {required: [{step: "global-check"}]});
  return yield* (yield* fixture.makeDefinitions()).load(snapshotProjectId, "thread");
});

const metaValue = (stores: ConversationStores, key: string) => Effect.gen(function* () {
  const rows = yield* query(stores.sql, "SELECT value FROM meta WHERE key=?", key);
  return rows[0]?.value;
});

it.effect("global master starts on while project auto-detection persists the first known folder result", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  assert.equal((yield* store.control(null)).enabled, true);
  assert.equal((yield* store.control("project-a")).enabled, false);
  assert.equal((yield* store.control("project-a")).detectionStatus, "not_checked");
  let folderStatus: SupervisionFolderPresence = {status: "unavailable", message: "read denied"};
  const events: string[] = [];
  yield* TestClock.setTime(1_000_000);
  const supervisor = yield* makeProjectSupervisor(stores, {presence: () => Effect.succeed(folderStatus),
    activation: () => {events.push("boundary");return Effect.succeed(baseline("run-2"));}});
  yield* supervisor.control("project-a");
  assert.equal(yield* store.autoControlInitialized("project-a"), false);
  assert.equal((yield* store.control("project-a")).detectionStatus, "unavailable");
  folderStatus = {status: "present"};
  yield* TestClock.adjust(60_000);
  const enabled = yield* supervisor.control("project-a");
  assert.deepEqual(events, ["boundary"]);
  assert.equal(enabled.detectionStatus, "present");
  assert.equal(enabled.effectiveEnabled, true);
  assert.equal((yield* store.control("project-a")).enabled, true);
  folderStatus = {status: "missing"};
  yield* supervisor.control("project-a");
  assert.equal((yield* store.control("project-a")).enabled, true);
  yield* store.recordFolderPresence("project-empty", {status: "missing"});
  assert.equal((yield* store.control("project-empty")).enabled, false);
  yield* store.recordFolderPresence("project-auto", {status: "present"}, baseline("run-3"));
  yield* store.saveControl("project-auto", 0, true);
  assert.equal((yield* store.control("project-auto")).manual, true);
  assert.equal((yield* store.control("project-auto")).enabled, true);
  const restarted = (yield* openStores(stores.directory, stores.directory)).supervisors;
  assert.equal((yield* restarted.control("project-a")).enabled, true);
  assert.equal((yield* restarted.control("project-a")).manual, false);
  assert.equal((yield* restarted.control("project-empty")).enabled, false);
  assert.equal(yield* restarted.autoControlInitialized("project-empty"), true);
})));

it.effect("auto-enable stays unavailable and retries when the native activation boundary cannot be captured", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  let failBoundary = true;
  let calls = 0;
  yield* TestClock.setTime(1_000_000);
  const supervisor = yield* makeProjectSupervisor(stores, {
    presence: () => Effect.succeed({status: "present"}),
    activation: () => {calls += 1;if (failBoundary) return Effect.fail(new Error("archive snapshot unavailable"));return Effect.succeed(baseline("run-2"));},
  });
  const first = yield* supervisor.control("project-a");
  assert.equal(first.enabled, false);
  assert.equal(first.detectionStatus, "unavailable");
  assert.match(first.detectionError ?? "", /native enable boundary/);
  assert.equal(yield* store.autoControlInitialized("project-a"), false);
  failBoundary = false;
  yield* TestClock.adjust(60_000);
  const retry = yield* supervisor.control("project-a");
  assert.equal(retry.enabled, true);
  assert.equal(retry.detectionStatus, "present");
  assert.equal(calls, 2);
})));

it.effect("unavailable folder checks back off for a minute without rewriting their durable marker", () => withStores((stores) => Effect.gen(function* () {
  let presenceCalls = 0;
  let checkoutPresenceCalls = 0;
  yield* TestClock.setTime(1_000_000);
  const supervisor = yield* makeProjectSupervisor(stores, {
    presence: () => {presenceCalls += 1;return Effect.succeed({status: "unavailable", message: "read denied"});},
    checkoutTargets: () => Effect.succeed([{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true, members: []}]),
    presenceForCheckout: () => {checkoutPresenceCalls += 1;return Effect.succeed({status: "present"});},
  });
  yield* supervisor.control("project-a");
  const markerKey = `supervisor_control_presence_unavailable:${JSON.stringify("project-a")}`;
  const markerBefore = yield* metaValue(stores, markerKey);
  assert.equal(presenceCalls, 1);
  assert.ok(markerBefore);

  yield* TestClock.adjust(59_999);
  yield* supervisor.control("project-a");
  assert.equal(presenceCalls, 1, "automatic retries wait the full minute");
  yield* TestClock.adjust(1);
  yield* supervisor.control("project-a");
  assert.equal(presenceCalls, 2);
  assert.equal(yield* metaValue(stores, markerKey), markerBefore,
    "the durable unavailable marker is written only once");

  yield* supervisor.setupOptions("project-a");
  assert.equal(presenceCalls, 2, "setup checks use the checkout-specific reader");
  assert.equal(checkoutPresenceCalls, 1, "an explicit setup check does not inherit the automatic backoff");
})));

it.effect("an auto-present record without a project boundary stays off until a fresh boundary is saved", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  yield* execute(stores.sql, "INSERT INTO meta VALUES(?,?)", `supervisor_control_auto:${JSON.stringify("project-a")}`, JSON.stringify({status: "present", enabled: true, checkedAt: 1}));
  assert.equal(yield* store.autoControlInitialized("project-a"), false);
  assert.equal((yield* store.control("project-a")).enabled, false);
  let captures = 0;
  const supervisor = yield* makeProjectSupervisor(stores, {presence: () => Effect.succeed({status: "present"}),
    activation: () => {captures += 1;return Effect.succeed(baseline("run-4"));}});
  const control = yield* supervisor.control("project-a");
  assert.equal(control.enabled, true);
  assert.equal(captures, 1);
  assert.equal(yield* store.autoControlInitialized("project-a"), true);
})));

it.effect("manual project choice survives restart and global master off remains independent", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  yield* store.recordFolderPresence("project-a", {status: "present"});
  yield* store.saveControl("project-a", 0, false);
  yield* store.recordFolderPresence("project-a", {status: "present"});
  assert.equal((yield* store.control("project-a")).enabled, false);
  assert.equal((yield* store.control("project-a")).manual, true);
  yield* store.saveControl(null, 0, false);
  yield* store.saveControl("project-a", 1, true);
  assert.equal((yield* store.control("project-a")).enabled, true);
  assert.equal((yield* store.control("project-a")).effectiveEnabled, false);
  assert.equal(yield* store.useGlobalDefinitions(), false);
  const restarted = (yield* openStores(stores.directory, stores.directory)).supervisors;
  assert.equal((yield* restarted.control(null)).enabled, false);
  assert.equal((yield* restarted.control("project-a")).enabled, true);
  assert.equal((yield* restarted.control("project-a")).effectiveEnabled, false);
  yield* restarted.saveControl(null, 1, true, baseline("run-1"));
  assert.equal((yield* restarted.control("project-a")).effectiveEnabled, true);
})));

it.effect("explicit project enable asks for checkout setup when the folder is missing", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const supervisor = yield* makeProjectSupervisor(stores, {presence: () => Effect.succeed({status: "missing"})});
  const current = yield* supervisor.control("project-a");
  assert.equal(current.enabled, false);
  const result = yield* supervisor.saveControl({projectId: "project-a", expectedGeneration: 0, enabled: true});
  assert.equal(result.status, "setup_required");
  assert.equal((yield* store.control("project-a")).enabled, false);
})));

it.effect("project setup captures the native enable boundary before writing and retains it", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const events: string[] = [];
  const supervisor = yield* makeProjectSupervisor(stores, {
    presence: () => Effect.succeed({status: "missing"}),
    checkoutTargets: () => Effect.succeed([{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true, members: []}]),
    presenceForCheckout: () => Effect.succeed({status: "missing"}),
    activation: () => {events.push("boundary");return Effect.succeed(baseline("run-2"));},
    initialize: (_projectId, _threadId, input) => {events.push(`initialize:${input.action}`);return Effect.succeed({status: "created", workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch, message: "created"});},
  });
  yield* supervisor.control("project-a");
  const result = yield* supervisor.setup({projectId: "project-a", expectedGeneration: 0, origin: "project", threadId: null,
    expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main", action: "create"});
  assert.equal(result.status, "saved", result.message);
  assert.deepEqual(events, ["boundary", "initialize:create"]);
  const projection: Projection = {thread: {id: "main", projectId: "project-a", title: "Main", lineage: {parentThreadId: null, relationshipToParent: null}},
    runs: [{id: "run-1", threadId: "main", ordinal: 1, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
      {id: "run-2", threadId: "main", ordinal: 2, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
      {id: "run-3", threadId: "main", ordinal: 3, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null}], messages: []};
  assert.equal(yield* store.baselineOrdinal("main", projection), 2);
})));

it.effect("enable_existing adopts a present checkout without running the project initializer", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const events: string[] = [];
  let initializeCalls = 0;
  const supervisor = yield* makeProjectSupervisor(stores, {
    presence: () => {events.push("auto-presence");return Effect.succeed({status: "unavailable", message: "not readable from the default scope"});},
    checkoutTargets: () => {events.push("checkout-targets");return Effect.succeed([{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true, members: []}]);},
    presenceForCheckout: () => {events.push("checkout-presence");return Effect.succeed({status: "present"});},
    initialize: (_projectId, _threadId, input) => {initializeCalls += 1;return Effect.succeed({status: "created", workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch, message: "unexpected create"});},
    activation: () => {events.push("boundary");return Effect.succeed(baseline("run-2"));},
  });
  const before = yield* supervisor.control("project-a");
  assert.equal(before.enabled, false);
  const result = yield* supervisor.setup({projectId: "project-a", expectedGeneration: before.generation, origin: "project", threadId: null,
    expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main", action: "enable_existing"});

  assert.equal(result.status, "saved", result.message);
  assert.deepEqual(events, ["auto-presence", "checkout-targets", "checkout-presence", "boundary", "checkout-targets", "checkout-presence"]);
  assert.equal(initializeCalls, 0);
  assert.equal(result.control.enabled, true);
  assert.equal(result.control.manual, true);
  assert.equal(result.control.detectionStatus, "present");
  assert.equal((yield* store.projectBoundary("project-a"))?.snapshotSequence, 20);
  assert.equal(yield* store.folderPresenceNeedsBoundary("project-a"), false);
  assert.match(result.message, /No files were written or committed/);
})));

it.effect("enable_existing rechecks folder presence after capturing its boundary", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  let checkoutPresenceChecks = 0;
  let boundaryCaptures = 0;
  const supervisor = yield* makeProjectSupervisor(stores, {
    presence: () => Effect.succeed({status: "unavailable", message: "default presence unavailable"}),
    checkoutTargets: () => Effect.succeed([{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true, members: []}]),
    presenceForCheckout: () => {checkoutPresenceChecks += 1;return Effect.succeed({status: checkoutPresenceChecks === 1 ? "present" as const : "missing" as const});},
    activation: () => {boundaryCaptures += 1;return Effect.succeed(baseline("run-2"));},
  });
  const before = yield* supervisor.control("project-a");
  const result = yield* supervisor.setup({projectId: "project-a", expectedGeneration: before.generation, origin: "project", threadId: null,
    expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main", action: "enable_existing"});

  assert.equal(result.status, "conflict");
  assert.equal(checkoutPresenceChecks, 2);
  assert.equal(boundaryCaptures, 1);
  assert.equal((yield* store.control("project-a")).enabled, false);
  assert.equal((yield* store.control("project-a")).manual, false);
  assert.equal(yield* store.projectBoundary("project-a"), null, "a failed final presence check must not save the enable boundary");
})));

it.effect("enable_existing rejects a worktree whose selected branch changed during setup", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const main: ThreadInfo = {id: "main", title: "Main", projectId: "project-a", lineage: {parentThreadId: null, relationshipToParent: null}};
  const threadProjection: Projection = {thread: {...main, worktreePath: "/work/feature"}, runs: [], messages: [], nodes: []};
  let targetChecks = 0;
  let presenceChecks = 0;
  const supervisor = yield* makeProjectSupervisor(stores, {
    catalog: () => Effect.succeed({projects: [{project, available: true}], threads: [main]}),
    projection: () => Effect.succeed(threadProjection),
    activation: () => Effect.succeed(baseline("run-2")),
    presence: () => Effect.succeed({status: "unavailable", message: "default presence unavailable"}),
    checkoutTargets: () => {
      targetChecks += 1;
      return Effect.succeed([{origin: "project" as const, threadId: "main", workspaceRoot: "/work/feature", branch: targetChecks === 1 ? "feature" : "other", isGitRepository: true, members: []}]);
    },
    presenceForCheckout: () => {presenceChecks += 1;return Effect.succeed({status: "present" as const});},
  });
  const current = yield* supervisor.control("project-a");
  const result = yield* supervisor.setup({projectId: "project-a", expectedGeneration: current.generation, origin: "project", threadId: "main",
    expectedWorkspaceRoot: "/work/feature", expectedBranch: "feature", action: "enable_existing"});

  assert.equal(result.status, "conflict");
  assert.equal(targetChecks, 2);
  assert.equal(presenceChecks, 1, "the changed branch is rejected before the final presence confirmation");
  assert.equal((yield* store.control("project-a")).enabled, false);
  assert.equal(yield* store.projectBoundary("project-a"), null);
})));

it.effect("enable_existing requires a present folder and create still rejects existing folders", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  let folderStatus: SupervisionFolderPresence["status"] = "missing";
  let initialized = 0;
  let boundaries = 0;
  const supervisor = yield* makeProjectSupervisor(stores, {
    presence: () => Effect.succeed({status: "unavailable", message: "default presence unavailable"}),
    checkoutTargets: () => Effect.succeed([{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true, members: []}]),
    presenceForCheckout: () => Effect.succeed({status: folderStatus}),
    initialize: (_projectId, _threadId, input) => {initialized += 1;return Effect.succeed({status: "created", workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch, message: "created"});},
    activation: () => {boundaries += 1;return Effect.succeed(baseline("run-2"));},
  });
  const current = yield* supervisor.control("project-a");
  const input = {projectId: "project-a", expectedGeneration: current.generation, origin: "project" as const, threadId: null,
    expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main"};

  const missing = yield* supervisor.setup({...input, action: "enable_existing"});
  assert.equal(missing.status, "conflict");
  assert.equal((yield* store.control("project-a")).generation, current.generation);
  assert.equal((yield* store.control("project-a")).enabled, false);
  assert.equal(boundaries, 0);
  assert.equal(initialized, 0);

  folderStatus = "present";
  const create = yield* supervisor.setup({...input, action: "create"});
  assert.equal(create.status, "conflict");
  assert.equal(boundaries, 0);
  assert.equal(initialized, 0);
})));

it.effect("unreadable project detection is not saved as an opt-out and another project can resolve", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  let failure = true;
  const supervisor = yield* makeProjectSupervisor(stores, {presence: (checkedProjectId) => Effect.succeed(checkedProjectId === "project-a" && failure
    ? {status: "unavailable", message: "temporarily unreadable"} : {status: "present"})});
  const blocked = yield* supervisor.control("project-a");
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.detectionStatus, "unavailable");
  assert.equal(yield* store.autoControlInitialized("project-a"), false);
  failure = false;
  const otherProject = {id: "project-b", title: "Project B", workspaceRoot: "/work/project-b"} as ProjectInfo;
  const other = yield* makeProjectSupervisor(stores, {
    catalog: () => Effect.succeed({projects: [{project: otherProject, available: true}], threads: [] as ThreadInfo[]}),
    projection: () => Effect.fail(new T3TransportError("unused")),
    presence: () => Effect.succeed({status: "present"}),
    activation: () => Effect.succeed(baseline()),
  });
  assert.equal((yield* other.control("project-b")).enabled, true);
  assert.equal(yield* store.autoControlInitialized("project-b"), true);
})));

it.effect("global definitions stay off by default until explicitly enabled, even when the folder exists", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const events: string[] = [];
  const supervisor = yield* makeProjectSupervisor(stores, {
    presenceGlobal: () => Effect.succeed({status: "present", path: "~/.t3-supervisor"}),
    initializeGlobal: () => {events.push("initializeGlobal");return Effect.succeed({status: "unchanged", workspaceRoot: "~", branch: null, message: "preserved"});},
    globalFingerprint: () => {events.push("globalFingerprint");return Effect.succeed("global-sha");},
  });
  const before = yield* supervisor.globalDefinitionsControl;
  assert.equal(before.detectionStatus, "present");
  assert.equal(before.enabled, false);
  assert.equal(yield* store.useGlobalDefinitions("project-a"), false);
  const result = yield* supervisor.saveGlobalDefinitionsControl({expectedGeneration: 0, enabled: true});
  assert.equal(result.status, "saved");
  assert.equal(yield* store.useGlobalDefinitions("project-a"), true);
  assert.equal(events[0], "initializeGlobal");
  assert.equal(events.filter(event => event === "globalFingerprint").length, 2);
  assert.equal((yield* store.globalDefinitionsControl()).homePath, "~/.t3-supervisor");
  const restarted = (yield* openStores(stores.directory, stores.directory)).supervisors;
  assert.equal(yield* restarted.useGlobalDefinitions("project-a"), true);
})));

it.effect("global definitions effectiveEnabled follows the master and definitions truth table", () => Effect.gen(function* () {
  const cases = [
    {master: false, definitions: false, effective: false},
    {master: false, definitions: true, effective: false},
    {master: true, definitions: false, effective: false},
    {master: true, definitions: true, effective: true},
  ];
  for (const item of cases) yield* withStores((stores) => Effect.gen(function* () {
    const store = stores.supervisors;
    if (!item.master) yield* store.saveControl(null, 0, false);
    if (item.definitions) yield* store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-sha");
    const control = yield* store.globalDefinitionsControl();
    assert.equal(control.enabled, item.definitions);
    assert.equal(control.effectiveEnabled, item.effective);
    assert.equal(yield* store.useGlobalDefinitions("project-a"), item.definitions, "the loader sees the saved definition preference independently of the master");
  }));
}), { timeout: 60_000 });

it.effect("first explicit global definitions enable initializes a missing server-home folder before switching on", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const events: string[] = [];
  const settings = yield* stores.guidance.settings();
  yield* stores.guidance.classify("project-a", "scratch", settings.generation);
  yield* store.saveControl("project-a", 0, true, baseline("run-1"));
  const supervisor = yield* makeProjectSupervisor(stores, {
    presenceGlobal: () => Effect.succeed({status: "missing", path: "~/.t3-supervisor"}),
    initializeGlobal: () => {events.push("initializeGlobal");return Effect.succeed({status: "created", workspaceRoot: "~", branch: null, message: "created"});},
    globalFingerprint: () => {events.push("globalFingerprint");return Effect.succeed("created-global-sha");},
    activation: () => {events.push("boundary");return Effect.succeed(baseline("run-2"));},
  });
  const result = yield* supervisor.saveGlobalDefinitionsControl({expectedGeneration: 0, enabled: true});
  assert.equal(result.status, "saved");
  assert.deepEqual(events, ["initializeGlobal", "globalFingerprint", "globalFingerprint"]);
  assert.equal(yield* store.useGlobalDefinitions("project-a"), true);
  const projection: Projection = {thread: {id: "main", projectId: "project-a", title: "Main", lineage: {parentThreadId: null, relationshipToParent: null}},
    runs: [{id: "run-1", threadId: "main", ordinal: 1, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
      {id: "run-2", threadId: "main", ordinal: 2, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
      {id: "run-3", threadId: "main", ordinal: 3, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null}], messages: []};
  assert.equal(yield* store.baselineOrdinal("main", projection), 1);
})));

it.effect("No Project mode controls activation independently of shared definitions", () => withStores((stores) => Effect.gen(function* () {
  const store = stores.supervisors;
  const settings = yield* stores.guidance.settings();
  yield* stores.guidance.classify("project-a", "scratch", settings.generation);
  yield* store.saveControl("project-a", 0, true, baseline("run-1"));
  const supervisor = yield* makeProjectSupervisor(stores, {presence: () => Effect.succeed({status: "present"})});
  const control = yield* supervisor.control("project-a");
  assert.equal(control.enabled, true);
  assert.equal(control.effectiveEnabled, false);
  const result = yield* supervisor.saveControl({projectId: "project-a", expectedGeneration: control.generation, enabled: true});
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /Use the No Project mode/);
  yield* store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-sha");
  assert.equal((yield* supervisor.control("project-a")).effectiveEnabled, false);
  yield* supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "automatic"});
  assert.equal((yield* supervisor.control("project-a")).effectiveEnabled, true);
})));

it.effect("a global-definition toggle authorizes only that input scope and unchanged local catalogs", () => Effect.gen(function* () {
  const approved = yield* scopedDefinitionSnapshot(true);
  const disabled = yield* scopedDefinitionSnapshot(false);
  assert.equal(approved.status, "ready");
  assert.equal(disabled.status, "ready");
  assert.ok(approved.globalRevision);
  assert.equal(approved.steps.some(step => step.origin === "global"), true);
  assert.equal(disabled.steps.some(step => step.origin === "global"), false);
  yield* withStores((stores) => Effect.gen(function* () {
    const store = stores.supervisors;
    yield* store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", approved.globalRevision!);
    yield* store.saveGlobalDefinitionsControl(1, false, "~/.t3-supervisor", approved.globalRevision!);
    assert.equal(yield* store.definitionUserGlobalToggle(disabled, approved, 0, approved.globalRevision!), true);
    assert.equal(yield* store.definitionUserGlobalToggle(disabled, approved, 0, "changed-global-sha"), false);
    const editedLocal: ProjectDefinitionSnapshot = {...disabled, steps: disabled.steps.map(step => step.id === "local-check"
      ? {...step, description: "Changed local step."} : step)};
    assert.equal(yield* store.definitionUserGlobalToggle(editedLocal, approved, 0, approved.globalRevision!), false);
  }));
}));

it.effect("Scratch workflow introductions point to shared definitions and omit a project-local folder", () => Effect.gen(function* () {
  const definitionSnapshot = yield* scopedDefinitionSnapshot(true, true, "scratch-project", "/scratch");
  assert.equal(definitionSnapshot.globalOnly, true);
  assert.equal(definitionSnapshot.status, "ready");
  const globalReference = requiredReferences(definitionSnapshot.config)[0];
  assert.ok(globalReference && "step" in globalReference);
  const globalStep = definitionSnapshot.steps.find(step => step.id === globalReference.step);
  assert.ok(globalStep);
  const task = {
    id: "task-1", threadId: "thread", projectId: "scratch-project", sourceRunId: "run-1", sourceMessageId: "message-1", sourceOrdinal: 1,
    sourceHash: "hash", status: "inferred", objective: "Check the task", reason: "new task", updatedAt: 1, requestText: "", supervisorThreadId: "supervisor",
    messageId: "supervisor-objective:task-1", supervisorRunId: null, dispatchedAt: null, replayCount: 0,
    workflow: {status: "stale", message: "", workspaceRoot: definitionSnapshot.workspaceRoot, revision: definitionSnapshot.revision,
      globalRevision: definitionSnapshot.globalRevision ?? null, definitionsStatus: definitionSnapshot.status, definitionsComplete: definitionSnapshot.complete,
      requirementsKnown: true, requirements: [{kind: "step", id: globalStep.id, name: globalStep.name,
        source: {origin: globalStep.origin ?? null, path: globalStep.path ?? null, sourceId: globalStep.sourceId ?? null},
        state: "unknown", reason: "The stale task assessment is not reusable."}], issues: definitionSnapshot.issues, plan: null},
    workflowProposalId: "proposal-1",
    definitionSnapshot,
  } as TaskRecord;
  const text = workflowIntroductionText(task);
  assert.match(text, /This checkout uses shared definitions only/);
  assert.match(text, /\/server-home\/\.t3-supervisor\/project\.yaml/);
  assert.match(text, /\/server-home\/\.t3-supervisor\/steps\/global-check\.md/);
  assert.doesNotMatch(text, /\/scratch\/\.t3-supervisor/);
}));
