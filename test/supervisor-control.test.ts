import assert from "node:assert/strict";
import { it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { projectSupervisorUnit } from "./support/team-units.js";
import { workflowIntroductionText } from "../src/supervisor-conversation.js";
import { type SupervisorBaseline, type SupervisionFolderPresence } from "../src/project-supervisor-store.js";
import type { TaskRecord } from "../src/project-supervisor-store.js";
import { T3TransportError } from "../src/t3.js";
import { requiredReferences, type ProjectDefinitionSnapshot } from "../src/project-definitions-contract.js";
import type { ProjectInfo, Projection, SupervisorConfig, ThreadInfo } from "../src/types.js";
import { makeDefinitionFixture, stepSource } from "./project-definitions-fixture.js";
import { openGuidance, openSupervisors, type SupervisorsFacade } from "./support/store-units.js";

const baseline = (latestRunId: string | null = null): SupervisorBaseline => ({version: 2, snapshotSequence: 20,
  threads: latestRunId ? [{id: "main", latestRunId}] : []});

const makeProjectSupervisor = (store: SupervisorsFacade, overrides: {
  presence?: (projectId: string, signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  presenceGlobal?: (signal: AbortSignal) => Promise<SupervisionFolderPresence & {path?: string}>;
  globalFingerprint?: (signal: AbortSignal) => Promise<string | null>;
  initializeGlobal?: (signal: AbortSignal) => Promise<{status: "created" | "unchanged" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string; branch: null; message: string}>;
  checkoutTargets?: (projectId: string, signal: AbortSignal) => Promise<Array<{origin: "project"; threadId: string | null; workspaceRoot: string; branch: string | null; isGitRepository: boolean}>>;
  presenceForCheckout?: (projectId: string, threadId: string | null, signal: AbortSignal) => Promise<SupervisionFolderPresence>;
  initialize?: (projectId: string, threadId: string | null, input: {origin: "project"; action: "create" | "create_and_commit"; expectedWorkspaceRoot: string; expectedBranch: string | null}, signal: AbortSignal) => Promise<{status: "created" | "committed" | "unchanged" | "stale" | "conflict" | "permission_required" | "unavailable" | "uncertain"; workspaceRoot: string | null; branch: string | null; message: string}>;
  activationSnapshot?: (signal: AbortSignal) => Promise<SupervisorBaseline>;
  now?: () => number;
} = {}) => {
  const project: ProjectInfo = {id: "project-a", title: "Project A", workspaceRoot: "/work/project-a"};
  const source = {catalog: () => Effect.succeed({projects: [{project, available: true}], threads: []})};
  const t3 = {projection: () => Effect.fail(new T3TransportError("unexpected projection"))};
  const config: SupervisorConfig = {dataDirectory: "/tmp", t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0};
  const definitions = {
    load: async () => {throw new Error("unexpected definition load");},
    ...(overrides.presence ? {presence: overrides.presence} : {}),
    ...(overrides.presenceGlobal ? {presenceGlobal: overrides.presenceGlobal} : {}),
    ...(overrides.globalFingerprint ? {globalFingerprint: overrides.globalFingerprint} : {}),
    ...(overrides.initializeGlobal ? {initializeGlobal: overrides.initializeGlobal} : {}),
    ...(overrides.checkoutTargets ? {checkoutTargets: overrides.checkoutTargets} : {}),
    ...(overrides.presenceForCheckout ? {presenceForCheckout: overrides.presenceForCheckout} : {}),
    ...(overrides.initialize ? {initialize: overrides.initialize} : {}),
    globalDefinitionsPath: () => "~/.t3-supervisor",
  };
  return projectSupervisorUnit(config, store, source, t3, async () => {throw new Error("unexpected read");}, null,
    overrides.activationSnapshot ?? (async () => baseline()), definitions, overrides.now);
};

const withStore = async <A>(work: (store: SupervisorsFacade, directory: string) => Promise<A> | A): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor-control-"));
  const guidance = await openGuidance(directory);
  const store = await openSupervisors(guidance, new Set());
  try {return await work(store, directory);}
  finally {await guidance.close();await rm(directory, {recursive: true, force: true});}
};

const scopedDefinitionSnapshot = async (globalEnabled: boolean, scratch = false, projectId = "project-a", root = "/work/project-a"): Promise<ProjectDefinitionSnapshot> => {
  const fixture = makeDefinitionFixture({projectId, root, threadRoot: root, globalEnabled, scratch});
  fixture.addFile(root, ".t3-supervisor/steps/local-check.md", stepSource("local-check", "Verify local behavior."));
  fixture.addDirectory(root, ".t3-supervisor/workflows");
  fixture.writeIndex(root, {required: [{step: "local-check"}]});
  fixture.addFile(fixture.globalRoot, ".t3-supervisor/steps/global-check.md", stepSource("global-check", "Verify shared behavior."));
  fixture.addDirectory(fixture.globalRoot, ".t3-supervisor/workflows");
  fixture.writeIndex(fixture.globalRoot, {required: [{step: "global-check"}]});
  return fixture.loader.load(projectId, "thread", AbortSignal.timeout(2000));
};

it("global master starts on while project auto-detection persists the first known folder result", async () => {
  await withStore(async (store, directory) => {
    assert.equal((await store.control(null)).enabled, true);
    assert.equal((await store.control("project-a")).enabled, false);
    assert.equal((await store.control("project-a")).detectionStatus, "not_checked");
    let folderStatus: SupervisionFolderPresence = {status: "unavailable", message: "read denied"};
    const events: string[] = [];
    let now = 1_000_000;
    const supervisor = makeProjectSupervisor(store, {presence: async () => folderStatus,
      now: () => now,
      activationSnapshot: async () => {events.push("boundary");return baseline("run-2");}});
    await supervisor.control("project-a", AbortSignal.timeout(2000));
    assert.equal(await store.autoControlInitialized("project-a"), false);
    assert.equal((await store.control("project-a")).detectionStatus, "unavailable");
    folderStatus = {status: "present"};
    now += 60_000;
    const enabled = await supervisor.control("project-a", AbortSignal.timeout(2000));
    assert.deepEqual(events, ["boundary"]);
    assert.equal(enabled.detectionStatus, "present");
    assert.equal(enabled.effectiveEnabled, true);
    assert.equal((await store.control("project-a")).enabled, true);
    folderStatus = {status: "missing"};
    await supervisor.control("project-a", AbortSignal.timeout(2000));
    assert.equal((await store.control("project-a")).enabled, true);
    await store.recordFolderPresence("project-empty", {status: "missing"});
    assert.equal((await store.control("project-empty")).enabled, false);
    await store.recordFolderPresence("project-auto", {status: "present"}, baseline("run-3"));
    await store.saveControl("project-auto", 0, true);
    assert.equal((await store.control("project-auto")).manual, true);
    assert.equal((await store.control("project-auto")).enabled, true);
    const guidance = await openGuidance(directory);
    const restarted = await openSupervisors(guidance, new Set());
    assert.equal((await restarted.control("project-a")).enabled, true);
    assert.equal((await restarted.control("project-a")).manual, false);
    assert.equal((await restarted.control("project-empty")).enabled, false);
    assert.equal(await restarted.autoControlInitialized("project-empty"), true);
    await guidance.close();
  });
});

it("auto-enable stays unavailable and retries when the native activation boundary cannot be captured", async () => {
  await withStore(async store => {
    let failBoundary = true;
    let calls = 0;
    let now = 1_000_000;
    const supervisor = makeProjectSupervisor(store, {
      now: () => now,
      presence: async () => ({status: "present"}),
      activationSnapshot: async () => {calls += 1;if (failBoundary) throw new Error("archive snapshot unavailable");return baseline("run-2");},
    });
    const signal = AbortSignal.timeout(2000);
    const first = await supervisor.control("project-a", signal);
    assert.equal(first.enabled, false);
    assert.equal(first.detectionStatus, "unavailable");
    assert.match(first.detectionError ?? "", /native enable boundary/);
    assert.equal(await store.autoControlInitialized("project-a"), false);
    failBoundary = false;
    now += 60_000;
    const retry = await supervisor.control("project-a", signal);
    assert.equal(retry.enabled, true);
    assert.equal(retry.detectionStatus, "present");
    assert.equal(calls, 2);
  });
});

it("unavailable folder checks back off for a minute without rewriting their durable marker", async () => {
  await withStore(async store => {
    let now = 1_000_000;
    let presenceCalls = 0;
    let checkoutPresenceCalls = 0;
    const supervisor = makeProjectSupervisor(store, {
      now: () => now,
      presence: async () => {presenceCalls += 1;return {status: "unavailable", message: "read denied"};},
      checkoutTargets: async () => [{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true}],
      presenceForCheckout: async () => {checkoutPresenceCalls += 1;return {status: "present"};},
    });
    const signal = AbortSignal.timeout(2000);
    await supervisor.control("project-a", signal);
    const markerKey = `supervisor_control_presence_unavailable:${JSON.stringify("project-a")}`;
    const markerBefore = (await store.store.db.prepare("SELECT value FROM meta WHERE key=?").get(markerKey))?.value;
    assert.equal(presenceCalls, 1);
    assert.ok(markerBefore);

    now += 59_999;
    await supervisor.control("project-a", signal);
    assert.equal(presenceCalls, 1, "automatic retries wait the full minute");
    now += 1;
    await supervisor.control("project-a", signal);
    assert.equal(presenceCalls, 2);
    assert.equal((await store.store.db.prepare("SELECT value FROM meta WHERE key=?").get(markerKey))?.value, markerBefore,
      "the durable unavailable marker is written only once");

    await supervisor.setupOptions("project-a", signal);
    assert.equal(presenceCalls, 2, "setup checks use the checkout-specific reader");
    assert.equal(checkoutPresenceCalls, 1, "an explicit setup check does not inherit the automatic backoff");
  });
});

it("an auto-present record without a project boundary stays off until a fresh boundary is saved", async () => {
  await withStore(async store => {
    await store.store.db.prepare("INSERT INTO meta VALUES(?,?)").run(`supervisor_control_auto:${JSON.stringify("project-a")}`, JSON.stringify({status: "present", enabled: true, checkedAt: 1}));
    assert.equal(await store.autoControlInitialized("project-a"), false);
    assert.equal((await store.control("project-a")).enabled, false);
    let captures = 0;
    const supervisor = makeProjectSupervisor(store, {presence: async () => ({status: "present"}),
      activationSnapshot: async () => {captures += 1;return baseline("run-4");}});
    const control = await supervisor.control("project-a", AbortSignal.timeout(2000));
    assert.equal(control.enabled, true);
    assert.equal(captures, 1);
    assert.equal(await store.autoControlInitialized("project-a"), true);
  });
});

it("manual project choice survives restart and global master off remains independent", async () => {
  await withStore(async (store, directory) => {
    await store.recordFolderPresence("project-a", {status: "present"});
    await store.saveControl("project-a", 0, false);
    await store.recordFolderPresence("project-a", {status: "present"});
    assert.equal((await store.control("project-a")).enabled, false);
    assert.equal((await store.control("project-a")).manual, true);
    await store.saveControl(null, 0, false);
    await store.saveControl("project-a", 1, true);
    assert.equal((await store.control("project-a")).enabled, true);
    assert.equal((await store.control("project-a")).effectiveEnabled, false);
    assert.equal(await store.useGlobalDefinitions(), false);
    const guidance = await openGuidance(directory);
    const restarted = await openSupervisors(guidance, new Set());
    assert.equal((await restarted.control(null)).enabled, false);
    assert.equal((await restarted.control("project-a")).enabled, true);
    assert.equal((await restarted.control("project-a")).effectiveEnabled, false);
    await restarted.saveControl(null, 1, true, baseline("run-1"));
    assert.equal((await restarted.control("project-a")).effectiveEnabled, true);
    await guidance.close();
  });
});

it("explicit project enable asks for checkout setup when the folder is missing", async () => {
  await withStore(async store => {
    const supervisor = makeProjectSupervisor(store, {presence: async () => ({status: "missing"})});
    const signal = AbortSignal.timeout(2000);
    const current = await supervisor.control("project-a", signal);
    assert.equal(current.enabled, false);
    const result = await supervisor.saveControl({projectId: "project-a", expectedGeneration: 0, enabled: true}, signal);
    assert.equal(result.status, "setup_required");
    assert.equal((await store.control("project-a")).enabled, false);
  });
});

it("project setup captures the native enable boundary before writing and retains it", async () => {
  await withStore(async store => {
    const events: string[] = [];
    const supervisor = makeProjectSupervisor(store, {
      presence: async () => ({status: "missing"}),
      checkoutTargets: async () => [{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true}],
      presenceForCheckout: async () => ({status: "missing"}),
      activationSnapshot: async () => {events.push("boundary");return baseline("run-2");},
      initialize: async (_projectId, _threadId, input) => {events.push(`initialize:${input.action}`);return {status: "created", workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch, message: "created"};},
    });
    const signal = AbortSignal.timeout(2000);
    await supervisor.control("project-a", signal);
    const result = await supervisor.setup({projectId: "project-a", expectedGeneration: 0, origin: "project", threadId: null,
      expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main", action: "create"}, signal);
    assert.equal(result.status, "saved", result.message);
    assert.deepEqual(events, ["boundary", "initialize:create"]);
    const projection: Projection = {thread: {id: "main", projectId: "project-a", title: "Main", lineage: {parentThreadId: null, relationshipToParent: null}},
      runs: [{id: "run-1", threadId: "main", ordinal: 1, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
        {id: "run-2", threadId: "main", ordinal: 2, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
        {id: "run-3", threadId: "main", ordinal: 3, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null}], messages: []};
    assert.equal(await store.baselineOrdinal("main", projection), 2);
  });
});

it("enable_existing adopts a present checkout without running the project initializer", async () => {
  await withStore(async store => {
    const events: string[] = [];
    let initializeCalls = 0;
    const supervisor = makeProjectSupervisor(store, {
      presence: async () => {events.push("auto-presence");return {status: "unavailable", message: "not readable from the default scope"};},
      checkoutTargets: async () => {events.push("checkout-targets");return [{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true}];},
      presenceForCheckout: async () => {events.push("checkout-presence");return {status: "present"};},
      initialize: async (_projectId, _threadId, input) => {initializeCalls += 1;return {status: "created", workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch, message: "unexpected create"};},
      activationSnapshot: async () => {events.push("boundary");return baseline("run-2");},
    });
    const signal = AbortSignal.timeout(2000);
    const before = await supervisor.control("project-a", signal);
    assert.equal(before.enabled, false);
    const result = await supervisor.setup({projectId: "project-a", expectedGeneration: before.generation, origin: "project", threadId: null,
      expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main", action: "enable_existing"}, signal);

    assert.equal(result.status, "saved", result.message);
    assert.deepEqual(events, ["auto-presence", "checkout-targets", "checkout-presence", "boundary", "checkout-targets", "checkout-presence"]);
    assert.equal(initializeCalls, 0);
    assert.equal(result.control.enabled, true);
    assert.equal(result.control.manual, true);
    assert.equal(result.control.detectionStatus, "present");
    assert.equal((await store.projectBoundary("project-a"))?.snapshotSequence, 20);
    assert.equal(await store.folderPresenceNeedsBoundary("project-a"), false);
    assert.match(result.message, /No files were written or committed/);
  });
});

it("enable_existing rechecks folder presence after capturing its boundary", async () => {
  await withStore(async store => {
    let checkoutPresenceChecks = 0;
    let boundaryCaptures = 0;
    const supervisor = makeProjectSupervisor(store, {
      presence: async () => ({status: "unavailable", message: "default presence unavailable"}),
      checkoutTargets: async () => [{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true}],
      presenceForCheckout: async () => {checkoutPresenceChecks += 1;return {status: checkoutPresenceChecks === 1 ? "present" as const : "missing" as const};},
      activationSnapshot: async () => {boundaryCaptures += 1;return baseline("run-2");},
    });
    const signal = AbortSignal.timeout(2000);
    const before = await supervisor.control("project-a", signal);
    const result = await supervisor.setup({projectId: "project-a", expectedGeneration: before.generation, origin: "project", threadId: null,
      expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main", action: "enable_existing"}, signal);

    assert.equal(result.status, "conflict");
    assert.equal(checkoutPresenceChecks, 2);
    assert.equal(boundaryCaptures, 1);
    assert.equal((await store.control("project-a")).enabled, false);
    assert.equal((await store.control("project-a")).manual, false);
    assert.equal(await store.projectBoundary("project-a"), null, "a failed final presence check must not save the enable boundary");
  });
});

it("enable_existing rejects a worktree whose selected branch changed during setup", async () => {
  await withStore(async store => {
    const project: ProjectInfo = {id: "project-a", title: "Project A", workspaceRoot: "/work/project-a"};
    const main: ThreadInfo = {id: "main", title: "Main", projectId: "project-a", lineage: {parentThreadId: null, relationshipToParent: null}};
    const projection: Projection = {thread: {...main, worktreePath: "/work/feature"}, runs: [], messages: [], nodes: []};
    const source = {catalog: () => Effect.succeed({projects: [{project, available: true}], threads: [main]})};
    let targetChecks = 0;
    let presenceChecks = 0;
    const definitions = {
      load: async () => {throw new Error("unexpected definition load");},
      presence: async () => ({status: "unavailable" as const, message: "default presence unavailable"}),
      checkoutTargets: async () => {
        targetChecks += 1;
        return [{origin: "project" as const, threadId: "main", workspaceRoot: "/work/feature", branch: targetChecks === 1 ? "feature" : "other", isGitRepository: true}];
      },
      presenceForCheckout: async () => {presenceChecks += 1;return {status: "present" as const};},
    };
    const supervisor = projectSupervisorUnit({dataDirectory: "/tmp", t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0}, store, source,
      {projection: () => Effect.succeed({projection, snapshotSequence: 20})}, async () => {throw new Error("unexpected read");}, null,
      async () => baseline("run-2"), definitions);
    const signal = AbortSignal.timeout(2000);
    const current = await supervisor.control("project-a", signal);
    const result = await supervisor.setup({projectId: "project-a", expectedGeneration: current.generation, origin: "project", threadId: "main",
      expectedWorkspaceRoot: "/work/feature", expectedBranch: "feature", action: "enable_existing"}, signal);

    assert.equal(result.status, "conflict");
    assert.equal(targetChecks, 2);
    assert.equal(presenceChecks, 1, "the changed branch is rejected before the final presence confirmation");
    assert.equal((await store.control("project-a")).enabled, false);
    assert.equal(await store.projectBoundary("project-a"), null);
  });
});

it("enable_existing requires a present folder and create still rejects existing folders", async () => {
  await withStore(async store => {
    let folderStatus: SupervisionFolderPresence["status"] = "missing";
    let initialized = 0;
    let boundaries = 0;
    const supervisor = makeProjectSupervisor(store, {
      presence: async () => ({status: "unavailable", message: "default presence unavailable"}),
      checkoutTargets: async () => [{origin: "project", threadId: null, workspaceRoot: "/work/project-a", branch: "main", isGitRepository: true}],
      presenceForCheckout: async () => ({status: folderStatus}),
      initialize: async (_projectId, _threadId, input) => {initialized += 1;return {status: "created", workspaceRoot: input.expectedWorkspaceRoot, branch: input.expectedBranch, message: "created"};},
      activationSnapshot: async () => {boundaries += 1;return baseline("run-2");},
    });
    const signal = AbortSignal.timeout(2000);
    const current = await supervisor.control("project-a", signal);
    const input = {projectId: "project-a", expectedGeneration: current.generation, origin: "project" as const, threadId: null,
      expectedWorkspaceRoot: "/work/project-a", expectedBranch: "main"};

    const missing = await supervisor.setup({...input, action: "enable_existing"}, signal);
    assert.equal(missing.status, "conflict");
    assert.equal((await store.control("project-a")).generation, current.generation);
    assert.equal((await store.control("project-a")).enabled, false);
    assert.equal(boundaries, 0);
    assert.equal(initialized, 0);

    folderStatus = "present";
    const create = await supervisor.setup({...input, action: "create"}, signal);
    assert.equal(create.status, "conflict");
    assert.equal(boundaries, 0);
    assert.equal(initialized, 0);
  });
});

it("unreadable project detection is not saved as an opt-out and another project can resolve", async () => {
  await withStore(async store => {
    let failure = true;
    const supervisor = makeProjectSupervisor(store, {presence: async projectId => projectId === "project-a" && failure
      ? {status: "unavailable", message: "temporarily unreadable"} : {status: "present"}});
    const signal = AbortSignal.timeout(2000);
    const blocked = await supervisor.control("project-a", signal);
    assert.equal(blocked.enabled, false);
    assert.equal(blocked.detectionStatus, "unavailable");
    assert.equal(await store.autoControlInitialized("project-a"), false);
    failure = false;
    const otherProject = {id: "project-b", title: "Project B", workspaceRoot: "/work/project-b"} as ProjectInfo;
    const otherSource = {catalog: () => Effect.succeed({projects: [{project: otherProject, available: true}], threads: []})};
    const other = projectSupervisorUnit({dataDirectory: "/tmp", t3Url: "http://unused", t3TokenFile: "unused", excludedThreadIds: [], healthPort: 0}, store, otherSource,
      {projection: () => Effect.fail(new T3TransportError("unused"))}, async () => {throw new Error("unused");}, null, async () => baseline(),
      {load: async () => {throw new Error("unused");}, presence: async () => ({status: "present"})});
    assert.equal((await other.control("project-b", signal)).enabled, true);
    assert.equal(await store.autoControlInitialized("project-b"), true);
  });
});

it("global definitions stay off by default until explicitly enabled, even when the folder exists", async () => {
  await withStore(async (store, directory) => {
    const events: string[] = [];
    const supervisor = makeProjectSupervisor(store, {
      presenceGlobal: async () => ({status: "present", path: "~/.t3-supervisor"}),
      initializeGlobal: async () => {events.push("initializeGlobal");return {status: "unchanged", workspaceRoot: "~", branch: null, message: "preserved"};},
      globalFingerprint: async () => {events.push("globalFingerprint");return "global-sha";},
    });
    const signal = AbortSignal.timeout(2000);
    const before = await supervisor.globalDefinitionsControl(signal);
    assert.equal(before.detectionStatus, "present");
    assert.equal(before.enabled, false);
    assert.equal(await store.useGlobalDefinitions("project-a"), false);
    const result = await supervisor.saveGlobalDefinitionsControl({expectedGeneration: 0, enabled: true}, signal);
    assert.equal(result.status, "saved");
    assert.equal(await store.useGlobalDefinitions("project-a"), true);
    assert.equal(events[0], "initializeGlobal");
    assert.equal(events.filter(event => event === "globalFingerprint").length, 2);
    assert.equal((await store.globalDefinitionsControl()).homePath, "~/.t3-supervisor");
    const guidance = await openGuidance(directory);
    assert.equal(await (await openSupervisors(guidance, new Set())).useGlobalDefinitions("project-a"), true);
    await guidance.close();
  });
});

it("global definitions effectiveEnabled follows the master and definitions truth table", { timeout: 60_000 }, async () => {
  const cases = [
    {master: false, definitions: false, effective: false},
    {master: false, definitions: true, effective: false},
    {master: true, definitions: false, effective: false},
    {master: true, definitions: true, effective: true},
  ];
  for (const item of cases) await withStore(async store => {
    if (!item.master) await store.saveControl(null, 0, false);
    if (item.definitions) await store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-sha");
    const control = await store.globalDefinitionsControl();
    assert.equal(control.enabled, item.definitions);
    assert.equal(control.effectiveEnabled, item.effective);
    assert.equal(await store.useGlobalDefinitions("project-a"), item.definitions, "the loader sees the saved definition preference independently of the master");
  });
});

it("first explicit global definitions enable initializes a missing server-home folder before switching on", async () => {
  await withStore(async store => {
    const events: string[] = [];
    const settings = await store.store.settings();
    await store.store.classify("project-a", "scratch", settings.generation);
    await store.saveControl("project-a", 0, true, baseline("run-1"));
    const supervisor = makeProjectSupervisor(store, {
      presenceGlobal: async () => ({status: "missing", path: "~/.t3-supervisor"}),
      initializeGlobal: async () => {events.push("initializeGlobal");return {status: "created", workspaceRoot: "~", branch: null, message: "created"};},
      globalFingerprint: async () => {events.push("globalFingerprint");return "created-global-sha";},
      activationSnapshot: async () => {events.push("boundary");return baseline("run-2");},
    });
    const result = await supervisor.saveGlobalDefinitionsControl({expectedGeneration: 0, enabled: true}, AbortSignal.timeout(2000));
    assert.equal(result.status, "saved");
    assert.deepEqual(events, ["initializeGlobal", "globalFingerprint", "globalFingerprint"]);
    assert.equal(await store.useGlobalDefinitions("project-a"), true);
    const projection: Projection = {thread: {id: "main", projectId: "project-a", title: "Main", lineage: {parentThreadId: null, relationshipToParent: null}},
      runs: [{id: "run-1", threadId: "main", ordinal: 1, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
        {id: "run-2", threadId: "main", ordinal: 2, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null},
        {id: "run-3", threadId: "main", ordinal: 3, status: "completed", requestedAt: "", startedAt: null, completedAt: null, rootNodeId: null}], messages: []};
    assert.equal(await store.baselineOrdinal("main", projection), 1);
  });
});

it("No Project mode controls activation independently of shared definitions", async () => {
  await withStore(async store => {
    const settings = await store.store.settings();
    await store.store.classify("project-a", "scratch", settings.generation);
    await store.saveControl("project-a", 0, true, baseline("run-1"));
    const supervisor = makeProjectSupervisor(store, {presence: async () => ({status: "present"})});
    const signal = AbortSignal.timeout(2000);
    const control = await supervisor.control("project-a", signal);
    assert.equal(control.enabled, true);
    assert.equal(control.effectiveEnabled, false);
    const result = await supervisor.saveControl({projectId: "project-a", expectedGeneration: control.generation, enabled: true}, signal);
    assert.equal(result.status, "unavailable");
    assert.match(result.message, /Use the No Project mode/);
    await store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-sha");
    assert.equal((await supervisor.control("project-a", signal)).effectiveEnabled, false);
    await supervisor.saveNoProjectControl({expectedGeneration: 0, mode: "automatic"}, signal);
    assert.equal((await supervisor.control("project-a", signal)).effectiveEnabled, true);
  });
});

it("a global-definition toggle authorizes only that input scope and unchanged local catalogs", async () => {
  const approved = await scopedDefinitionSnapshot(true);
  const disabled = await scopedDefinitionSnapshot(false);
  assert.equal(approved.status, "ready");
  assert.equal(disabled.status, "ready");
  assert.ok(approved.globalRevision);
  assert.equal(approved.steps.some(step => step.origin === "global"), true);
  assert.equal(disabled.steps.some(step => step.origin === "global"), false);
  await withStore(async store => {
    await store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", approved.globalRevision!);
    await store.saveGlobalDefinitionsControl(1, false, "~/.t3-supervisor", approved.globalRevision!);
    assert.equal(await store.definitionUserGlobalToggle(disabled, approved, 0, approved.globalRevision!), true);
    assert.equal(await store.definitionUserGlobalToggle(disabled, approved, 0, "changed-global-sha"), false);
    const editedLocal: ProjectDefinitionSnapshot = {...disabled, steps: disabled.steps.map(step => step.id === "local-check"
      ? {...step, description: "Changed local step."} : step)};
    assert.equal(await store.definitionUserGlobalToggle(editedLocal, approved, 0, approved.globalRevision!), false);
  });
});

it("Scratch workflow introductions point to shared definitions and omit a project-local folder", async () => {
  const definitionSnapshot = await scopedDefinitionSnapshot(true, true, "scratch-project", "/scratch");
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
});
