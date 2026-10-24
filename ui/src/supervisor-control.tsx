import {branchLabel} from "./checkout-identity.js";
import { HelpDisclosure } from "./disclosure.js";
import { GlobalSupervisionStatus, ProjectSupervisionStatus, StatusBadge } from "./supervision-status.js";
import React, { useContext, useEffect, useRef, useState } from "react";
import { Clock, Effect, Option, Result } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { type SupervisionSetupOptions, type SupervisionControlInfo, type GlobalDefinitionsControlInfo, type SupervisionSetupInput, type SupervisionControlInput,
  type GlobalDefinitionsControlInput, type SupervisionControlResult, type SupervisionSetupResult, type GlobalDefinitionsControlResult } from "../../src/supervisor-control-contract.js";
import { ApiClient, type MutationFailure } from "./api.js";
import { admit, admittedMutation, authEpochAtom, draftFamily, environmentAtom, scopeKey, uiRuntime, type MutationKey } from "./atoms.js";
import { ScopeMismatch } from "./project-supervisor-api.js";

export type ControlActivity = {busy: boolean; dirty: boolean; uncertain: boolean};
export const idleControlActivity: ControlActivity = {busy: false, dirty: false, uncertain: false};

// the setup fence: requests in flight, an epoch that every request start and end and every latch advances, and whether an
// unconfirmed setup outcome still blocks other changes
export type SetupFenceState = {readonly active: number; readonly epoch: number; readonly fenced: boolean};
export const idleSetupFence: SetupFenceState = {active: 0, epoch: 0, fenced: false};

// an unconfirmed setup outcome stays fenced until a setup read that started after every setup request had ended
export const setupFence = {
  latch: (state: SetupFenceState): SetupFenceState => ({...state, epoch: state.epoch + 1, fenced: true}),
  request: (state: SetupFenceState, started: boolean): SetupFenceState =>
    ({active: Math.max(0, state.active + (started ? 1 : -1)), epoch: state.epoch + 1, fenced: started || state.fenced}),
  verified: (state: SetupFenceState, readEpoch: number): SetupFenceState =>
    state.fenced && state.active === 0 && readEpoch === state.epoch ? {...state, fenced: false} : state,
  confirmed: (state: SetupFenceState): SetupFenceState => state.fenced && state.active <= 1 ? {...state, fenced: false} : state,
};

// the fence as a callback object: every request reports the state, other steps report only a change of the fence
export function createSetupFence(changed: (state: {fenced: boolean; pending: boolean}) => void) {
  let state = idleSetupFence;
  const move = (next: SetupFenceState, report = false) => {
    const before = state;
    state = next;
    if (report || next.fenced !== before.fenced) changed({fenced: state.fenced, pending: state.active > 0});
  };
  return {
    epoch: () => state.epoch,
    latch: () => move(setupFence.latch(state)),
    request: (started: boolean) => move(setupFence.request(state, started), true),
    verified: (readEpoch: number) => move(setupFence.verified(state, readEpoch)),
    confirmed: () => move(setupFence.confirmed(state)),
  };
}

const currentEpoch = <E,>(result: AsyncResult.AsyncResult<number, E>) => Option.getOrElse(AsyncResult.value(result), () => 0);

// the state of one supervision switch (a project's, or the master switch for null) that outlives the panel: the shown
// control, the outcome of the last change, the block after an unconfirmed change and the change in flight
export type SupervisionControlState = {
  control: SupervisionControlInfo | null;
  readAt: number | null;
  message: string;
  blocked: boolean;
  uncertain: boolean;
  setupRequested: boolean;
  toggling: string | null;
  saved: number;
};
const idleControlState: SupervisionControlState = {control: null, readAt: null, message: "", blocked: false, uncertain: false, setupRequested: false,
  toggling: null, saved: 0};
export const supervisionControlKey = (environmentId: string | null, projectId: string | null) => scopeKey("supervision-control", environmentId, projectId);
export const supervisionControlState = Atom.family((_key: string) => Atom.keepAlive(Atom.make(idleControlState)));

// the first-time setup of one project: its fence, the setup change in flight and the outcome of the last setup
export type SupervisionSetupState = {fence: SetupFenceState; operation: string | null; blocked: boolean; uncertain: boolean; message: string};
const idleSetupState: SupervisionSetupState = {fence: idleSetupFence, operation: null, blocked: false, uncertain: false, message: ""};
export const supervisionSetupState = Atom.family((_key: string) => Atom.keepAlive(Atom.make(idleSetupState)));
// the checkout chosen for setup, kept like a draft until a setup read or a verified setup clears it
export const supervisionSetupSelection = draftFamily(() => "");

type ControlReadScope = {readonly environmentId: string | null; readonly projectId: string | null; readonly revision: number; readonly epoch: number};

// one read of a supervision switch per scope revision; a response for another project is rejected
export const supervisionControlRead = Atom.family((scope: ControlReadScope) => uiRuntime.atom(Effect.gen(function* () {
  const client = yield* ApiClient;
  const control = yield* client.guidance.supervisionControl({query: scope.projectId === null ? {} : {projectId: scope.projectId}});
  if (control.projectId !== scope.projectId) return yield* new ScopeMismatch({message: "The supervision status belongs to another project."});
  return {control, readAt: yield* Clock.currentTimeMillis};
})));

type SetupReadScope = {readonly environmentId: string | null; readonly projectId: string; readonly revision: number; readonly epoch: number};

// one read of the setup choices per scope revision; it carries the fence epoch at its start so only a read that started
// after every setup request ended can verify an unconfirmed outcome
export const supervisionSetupRead = Atom.family((scope: SetupReadScope) => uiRuntime.atom((get) => {
  const readEpoch = get.once(supervisionSetupState(supervisionControlKey(scope.environmentId, scope.projectId))).fence.epoch;
  return Effect.gen(function* () {
    const client = yield* ApiClient;
    const options = yield* client.guidance.supervisionSetupOptions({query: {projectId: scope.projectId}});
    if (options.projectId !== scope.projectId) return yield* new ScopeMismatch({message: "The setup choices belong to another project."});
    return {options, readEpoch};
  });
}));

type GlobalDefinitionsReadScope = {readonly environmentId: string | null; readonly revision: number; readonly refreshKey: number; readonly epoch: number};

export const globalDefinitionsRead = Atom.family((_scope: GlobalDefinitionsReadScope) => uiRuntime.atom(Effect.gen(function* () {
  const client = yield* ApiClient;
  const control = yield* client.guidance.globalDefinitionsControl();
  return {control, readAt: yield* Clock.currentTimeMillis};
})));

// the state of the shared definitions switch of one T3 environment that outlives the panel
export type GlobalDefinitionsState = {control: GlobalDefinitionsControlInfo | null; readAt: number | null; message: string; blocked: boolean; uncertain: boolean;
  toggling: string | null};
export const globalDefinitionsKey = (environmentId: string | null) => scopeKey("global-definitions", environmentId);
export const globalDefinitionsState = Atom.family((_key: string) => Atom.keepAlive(Atom.make<GlobalDefinitionsState>({control: null, readAt: null, message: "",
  blocked: false, uncertain: false, toggling: null})));

// the admitted switch and setup requests; every change carries the generation it was made against (expectedGeneration)
const controlRequest = admittedMutation((input: SupervisionControlInput) => Effect.flatMap(ApiClient, client => client.guidance.saveSupervisionControl({payload: input})));
const setupRequest = admittedMutation((input: SupervisionSetupInput) => Effect.flatMap(ApiClient, client => client.guidance.setupSupervision({payload: input})));
const definitionsRequest = admittedMutation((input: GlobalDefinitionsControlInput) =>
  Effect.flatMap(ApiClient, client => client.guidance.saveGlobalDefinitionsControl({payload: input})));

type ControlChange<I> = {stateKey: string; key: MutationKey; input: I};

/** The outcome of one switch change; a result for another project or any failure is unconfirmed and blocks further changes. */
export const settleControlChange = (state: SupervisionControlState, projectId: string | null,
  outcome: Result.Result<typeof SupervisionControlResult.Type, MutationFailure>, now: number): SupervisionControlState => {
  const result = Result.isSuccess(outcome) && outcome.success.control.projectId === projectId ? outcome.success : null;
  if (!result) return {...state, toggling: null, blocked: true, uncertain: true, message: "The change could not be confirmed. Reload status before trying again."};
  const settled = result.status === "saved" || result.status === "setup_required";
  return {...state, toggling: null, control: result.control, readAt: now, message: result.message, blocked: !settled, uncertain: !settled,
    setupRequested: result.status === "setup_required", saved: state.saved + (result.status === "saved" ? 1 : 0)};
};

// awaits an admitted switch change and applies its outcome to the switch state, mounted or not, once
export const changeSupervisionControl = Atom.family((_key: string) => Atom.keepAlive(uiRuntime.fn((change: ControlChange<SupervisionControlInput>, get) => Effect.gen(function* () {
  const outcome = yield* Effect.result(admit(get.registry, controlRequest(change.key), change.input));
  const now = yield* Clock.currentTimeMillis;
  get.registry.update(supervisionControlState(change.stateKey), state =>
    state.toggling === change.key.operationId ? settleControlChange(state, change.input.projectId, outcome, now) : state);
}), {concurrent: true})));

/**
 * The outcome of one setup request: a verified result for the selected checkout releases the fence and completes setup; any
 * other result or failure ends the request and latches the fence until a fresh setup read.
 */
export const settleSetup = (setup: SupervisionSetupState, input: SupervisionSetupInput,
  outcome: Result.Result<typeof SupervisionSetupResult.Type, MutationFailure>): {setup: SupervisionSetupState; completed: typeof SupervisionSetupResult.Type | null} => {
  const result = Result.isSuccess(outcome) && outcome.success.control.projectId === input.projectId &&
    outcome.success.workspaceRoot === input.expectedWorkspaceRoot && outcome.success.branch === input.expectedBranch ? outcome.success : null;
  if (result?.status === "saved") return {completed: result,
    setup: {...setup, operation: null, blocked: false, uncertain: false, message: "", fence: setupFence.request(setupFence.confirmed(setup.fence), false)}};
  return {completed: null, setup: {...setup, operation: null, blocked: true, uncertain: true,
    message: result ? result.message : "The setup outcome could not be confirmed. Reload and inspect the selected checkout before trying again.",
    fence: setupFence.latch(setupFence.request(setup.fence, false))}};
};

// awaits an admitted setup request and applies its outcome to the project's setup and switch state, mounted or not, once
export const runSupervisionSetup = Atom.family((_key: string) => Atom.keepAlive(uiRuntime.fn((change: ControlChange<SupervisionSetupInput>, get) => Effect.gen(function* () {
  const outcome = yield* Effect.result(admit(get.registry, setupRequest(change.key), change.input));
  const registry = get.registry;
  const setupAtom = supervisionSetupState(change.stateKey);
  const setup = registry.get(setupAtom);
  if (setup.operation !== change.key.operationId) return;
  const next = settleSetup(setup, change.input, outcome);
  registry.set(setupAtom, next.setup);
  const completed = next.completed;
  if (!completed) return;
  registry.set(supervisionSetupSelection(change.stateKey), "");
  registry.update(supervisionControlState(change.stateKey), state => ({...state, control: completed.control, message: completed.message, setupRequested: false,
    uncertain: false, blocked: false}));
}), {concurrent: true})));

// admits one switch change against the shown control's generation unless the switch is busy or blocked
export const startControlChange = (registry: AtomRegistry.AtomRegistry, stateKey: string, projectId: string | null) => {
  const stateAtom = supervisionControlState(stateKey);
  const current = registry.get(stateAtom);
  if (!current.control || current.toggling || current.blocked) return;
  const key = {scope: stateKey, operationId: crypto.randomUUID()};
  registry.set(stateAtom, {...current, toggling: key.operationId, message: ""});
  registry.set(changeSupervisionControl(scopeKey(key.scope, key.operationId)), {stateKey, key,
    input: {projectId, expectedGeneration: current.control.generation, enabled: !current.control.enabled}});
};

// admits one setup request and fences it unless a setup request is in flight or the last outcome blocks setup
export const startSetup = (registry: AtomRegistry.AtomRegistry, stateKey: string, input: SupervisionSetupInput) => {
  const setupAtom = supervisionSetupState(stateKey);
  const current = registry.get(setupAtom);
  if (current.operation || current.blocked) return;
  const key = {scope: stateKey, operationId: crypto.randomUUID()};
  registry.set(setupAtom, {...current, operation: key.operationId, message: "", fence: setupFence.request(current.fence, true)});
  registry.set(runSupervisionSetup(scopeKey(key.scope, key.operationId)), {stateKey, key, input});
};

/** A settled setup read resets the last outcome; it verifies the fence only when it started after every setup request ended. */
export const settleSetupRead = (setup: SupervisionSetupState, readEpoch: number): SupervisionSetupState =>
  ({...setup, uncertain: false, blocked: false, message: "", fence: setupFence.verified(setup.fence, readEpoch)});

/** The outcome of one shared definitions switch change; anything but a saved result blocks until a reload. */
export const settleDefinitionsChange = (state: GlobalDefinitionsState, outcome: Result.Result<typeof GlobalDefinitionsControlResult.Type, MutationFailure>,
  now: number): GlobalDefinitionsState => {
  if (Result.isFailure(outcome)) return {...state, toggling: null, blocked: true, uncertain: true,
    message: "The global definitions change could not be confirmed. Reload status before trying again."};
  const result = outcome.success;
  return {...state, toggling: null, control: result.control, readAt: now, message: result.message, blocked: result.status !== "saved", uncertain: result.status !== "saved"};
};

export const changeGlobalDefinitions = Atom.family((_key: string) => Atom.keepAlive(uiRuntime.fn((change: ControlChange<GlobalDefinitionsControlInput>, get) => Effect.gen(function* () {
  const outcome = yield* Effect.result(admit(get.registry, definitionsRequest(change.key), change.input));
  const now = yield* Clock.currentTimeMillis;
  get.registry.update(globalDefinitionsState(change.stateKey), state => state.toggling === change.key.operationId ? settleDefinitionsChange(state, outcome, now) : state);
}), {concurrent: true})));

// admits one shared definitions switch change against the shown control's generation unless the switch is busy or blocked
export const startGlobalDefinitionsChange = (registry: AtomRegistry.AtomRegistry, stateKey: string) => {
  const stateAtom = globalDefinitionsState(stateKey);
  const current = registry.get(stateAtom);
  if (!current.control || current.toggling || current.blocked) return;
  const key = {scope: stateKey, operationId: crypto.randomUUID()};
  registry.set(stateAtom, {...current, toggling: key.operationId, message: ""});
  registry.set(changeGlobalDefinitions(scopeKey(key.scope, key.operationId)), {stateKey, key,
    input: {expectedGeneration: current.control.generation, enabled: !current.control.enabled}});
};

export function SupervisionControlView({control, busy, blocked, message, onToggle, onReload, readAt}: {
  control: SupervisionControlInfo;
  readAt?: number | null;
  busy: boolean;
  blocked: boolean;
  message: string;
  onToggle: () => void;
  onReload: () => void;
}) {
  const global = control.projectId === null;
  const Heading = global ? "h2" : "h3";
  return <section className="panel stack settings-control" aria-label={global ? "Global supervision" : "Project supervision"}>
    <div className="row between control-heading"><Heading>{global ? "Global supervision" : "Project supervision"}</Heading>{global ? <GlobalSupervisionStatus enabled={control.globallyEnabled}/> : <ProjectSupervisionStatus enabled={control.enabled} effectiveEnabled={control.effectiveEnabled} globallyEnabled={control.globallyEnabled}/>}</div>{!global && control.enabled && !control.globallyEnabled && <p className="notice">The global supervision switch is off.</p>}
    <p>{global ? "The master switch controls semantic supervision across every project and starts enabled." : "This project is supervised only when both its switch and the master switch are enabled. An existing .t3-supervisor folder enables a project initially; your manual choice is remembered."}</p>
    <HelpDisclosure title={<>How this switch works</>} >{global && <p>Global On applies only to enabled projects and eligible conversations. It does not mean every chat is supervised.</p>}{!global && <p>Folder detection: {control.detectionStatus}. {control.detectionError}</p>}
    <p>Disabling stops new supervisory work. An already-running model turn may finish. Chats, settings and recorded history are retained.</p></HelpDisclosure>
    <div className="row">
      <button type="button" className={control.enabled ? "danger-button" : "primary"} disabled={busy || blocked} onClick={onToggle}>{busy ? "Saving…" : control.enabled ? "Disable supervision" : "Enable supervision"}</button>
      <button type="button" className="quiet-button" title={readAt ? `Last read ${new Date(readAt).toLocaleTimeString()}` : undefined} disabled={busy} onClick={onReload}>Reload status</button>
    </div>
    <p role="status">{message}</p>
  </section>;
}

export function SupervisionControlPanel({projectId = null, onChanged, onStateChange, active = true}: {active?: boolean; projectId?: string | null; onChanged?: () => void; onStateChange?: (activity: ControlActivity) => void}) {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(environmentAtom);
  const stateKey = supervisionControlKey(environmentId, projectId);
  const epoch = useAtomValue(authEpochAtom, currentEpoch);
  const [state, setState] = useAtom(supervisionControlState(stateKey));
  const setup = useAtomValue(supervisionSetupState(stateKey));
  const selected = useAtomValue(supervisionSetupSelection(stateKey));
  const [revision, setRevision] = useState(0);
  const [reported, setReported] = useState(state.saved);
  const {control, blocked, message, uncertain, setupRequested} = state;
  const busy = state.toggling !== null;
  const setupActivity = setupRequested ? {busy: setup.operation !== null, dirty: Boolean(selected), uncertain: setup.uncertain} : idleControlActivity;
  const fenceState = {fenced: setup.fence.fenced, pending: setup.fence.active > 0};
  const setupBusy = setupActivity.busy || fenceState.pending;
  const setupUncertain = setupActivity.uncertain || fenceState.fenced;
  useEffect(() => {onStateChange?.({busy: busy || setupBusy, dirty: setupActivity.dirty, uncertain: uncertain || setupUncertain});}, [busy, uncertain, setupBusy, setupUncertain, setupActivity.dirty, onStateChange]);
  // a confirmed change of this switch is reported while the panel is mounted
  useEffect(() => {
    if (state.saved === reported) return;
    setReported(state.saved);
    onChanged?.();
  }, [state.saved, reported, onChanged]);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && !busy && !uncertain && !setupRequested) setRevision(value => value + 1);
    wasActive.current = active;
  }, [active, busy, uncertain, setupRequested]);
  // each read shows the loading state until it settles; a read for another project is unavailable
  const readKey = scopeKey(environmentId, projectId, revision, epoch);
  const read = useAtomValue(supervisionControlRead({environmentId, projectId, revision, epoch}));
  useEffect(() => {setState(current => ({...current, control: null}));}, [readKey, setState]);
  useEffect(() => {
    if (AsyncResult.isSuccess(read) && !read.waiting)
      setState(current => ({...current, control: read.value.control, readAt: read.value.readAt, blocked: false, uncertain: false, message: ""}));
    else if (AsyncResult.isFailure(read)) setState(current => ({...current, blocked: true, message: "Supervision status unavailable. Reload before changing it."}));
  }, [read, setState]);
  if (!control) return <section className="panel"><p role="status">{message || "Loading supervision status…"}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Reload status</button></section>;
  return <div className="stack"><SupervisionControlView readAt={state.readAt} control={control} busy={busy || setupBusy} blocked={blocked || setupUncertain} message={message}
    onReload={() => setRevision(value => value + 1)} onToggle={() => {
      if (!setupBusy && !setupUncertain) startControlChange(registry, stateKey, projectId);
    }} />

    {setupUncertain && !setupActivity.uncertain && <p className="notice" role="status">The last setup outcome is not confirmed. Reload setup to check the selected checkout before other changes.</p>}
    {setupRequested && projectId && <SupervisionSetupPanel projectId={projectId} stateKey={stateKey} locked={setupBusy && !setupActivity.busy || fenceState.fenced && !setupActivity.uncertain} />}</div>;
}

type SetupOptions = typeof SupervisionSetupOptions.Type;
type SetupCheckout = SetupOptions["checkouts"][number];
const checkoutKey = (checkout: SetupCheckout) => JSON.stringify([checkout.threadId, checkout.workspaceRoot]);
const checkoutBranch = (checkout: SetupCheckout) => branchLabel({...checkout, vcsAvailable: true});

export function buildSupervisionSetupIntent(projectId: string, generation: number, checkout: SetupCheckout, action: SupervisionSetupInput["action"]): SupervisionSetupInput {
  return {projectId, expectedGeneration: generation, threadId: checkout.threadId, expectedWorkspaceRoot: checkout.workspaceRoot,
    expectedBranch: checkout.branch, origin: checkout.origin, action};
}

export function SupervisionSetupView({options, selected, busy, blocked, message, onSelect, onSetup, onReload}: {
  options: SetupOptions; selected: string; busy: boolean; blocked: boolean; message: string;
  onSelect: (key: string) => void; onSetup: (action: SupervisionSetupInput["action"]) => void; onReload: () => void;
}) {
  const checkout = options.checkouts.find(value => checkoutKey(value) === selected);
  const canCreate = !busy && !blocked && options.available && checkout?.folderStatus === "missing";
  const canEnableExisting = !busy && !blocked && options.available && checkout?.folderStatus === "present";
  return <section className="panel stack" aria-label="Supervisor definition setup">
    <h4>First-time setup</h4><p>{options.message}</p>
    <label htmlFor="supervisor-setup-checkout">Checkout</label>
    <select id="supervisor-setup-checkout" value={selected} disabled={busy || blocked} onChange={event => onSelect(event.target.value)}>
      <option value="">Choose a checkout</option>
      {options.checkouts.map(value => <option key={checkoutKey(value)} value={checkoutKey(value)}>{value.workspaceRoot} — {checkoutBranch(value)}</option>)}
    </select>
    {checkout && <div><p>Folder: <code>{checkout.workspaceRoot}/.t3-supervisor</code></p><p><strong>{checkoutBranch(checkout)}</strong></p><p>Existing setup: {checkout.folderStatus}.</p></div>}
    {checkout?.folderStatus === "present" ? <div>
      <p>Enable the existing definitions at <code>{checkout.workspaceRoot}/.t3-supervisor</code> · <strong>{checkoutBranch(checkout)}</strong>. This enables supervision using those files; no files will be written or committed.</p>
      <button type="button" disabled={!canEnableExisting} onClick={() => onSetup("enable_existing")}>Enable existing definitions</button>
    </div> : <p>Create leaves files uncommitted. Create + commit submits the two setup paths from a clean checkout through T3. Repository hooks and signing apply; hooks can alter committed contents, and failure can leave files staged. Neither action switches branches.</p>}
    <div className="row">
      <button type="button" disabled={!canCreate} onClick={() => onSetup("create")}>Create</button>
      <button type="button" disabled={!canCreate || !checkout?.isGitRepository} onClick={() => onSetup("create_and_commit")}>Create + commit</button>
      <button type="button" className="quiet-button" disabled={busy} onClick={onReload}>Reload setup</button>
    </div><p role="status">{message}</p>
  </section>;
}

function SupervisionSetupPanel({projectId, stateKey, locked}: {projectId: string; stateKey: string; locked: boolean}) {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(environmentAtom);
  const epoch = useAtomValue(authEpochAtom, currentEpoch);
  const [setupState, setSetupState] = useAtom(supervisionSetupState(stateKey));
  const [selected, setSelected] = useAtom(supervisionSetupSelection(stateKey));
  const [revision, setRevision] = useState(0);
  const read = useAtomValue(supervisionSetupRead({environmentId, projectId, revision, epoch}));
  const options = AsyncResult.isSuccess(read) && !read.waiting ? read.value.options : null;
  // a settled read resets the choice and the last outcome; a read that started after every setup request ended verifies the fence
  useEffect(() => {
    if (AsyncResult.isSuccess(read) && !read.waiting) {
      setSelected("");
      setSetupState(current => settleSetupRead(current, read.value.readEpoch));
    } else if (AsyncResult.isFailure(read)) setSetupState(current => ({...current, blocked: true, message: "Setup targets unavailable. Reload before creating files."}));
  }, [read, setSelected, setSetupState]);
  const {blocked, message} = setupState;
  const busy = setupState.operation !== null;
  if (!options) return <section className="panel"><p role="status">{message || "Loading checkout choices…"}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Reload setup</button></section>;
  const setup = (action: SupervisionSetupInput["action"]) => {
    const checkout = options.checkouts.find(value => checkoutKey(value) === selected);
    const expectedFolderStatus = action === "enable_existing" ? "present" : "missing";
    if (!checkout || locked || !options.available || checkout.folderStatus !== expectedFolderStatus) return;
    startSetup(registry, stateKey, buildSupervisionSetupIntent(projectId, options.generation, checkout, action));
  };
  return <SupervisionSetupView options={options} selected={selected} busy={busy} blocked={blocked || locked}
    message={message || (locked ? "The previous setup outcome is not confirmed yet. Reload setup after it settles to check the checkout again." : "")}
    onSelect={setSelected} onSetup={setup} onReload={() => setRevision(value => value + 1)} />;
}

export function GlobalDefinitionsControlView({control, busy, blocked, message, onToggle, onReload, readAt}: {
  control: GlobalDefinitionsControlInfo; readAt?: number | null; busy: boolean; blocked: boolean; message: string; onToggle: () => void; onReload: () => void;
}) {
  return <section className="panel stack settings-control" aria-label="Use global steps and workflows">
    <div className="row between control-heading"><h3>Use global steps and workflows</h3><StatusBadge compact label={control.enabled ? "Global definitions: On" : "Global definitions: Off"} tone={control.enabled ? "on" : "off"}/></div>{control.enabled && !control.effectiveEnabled && <p className="notice">The master supervision switch is off.</p>}
    <p>Share reusable steps and workflows across enabled projects and No Project chats.</p><HelpDisclosure title={<>Shared definition files and behavior</>} ><p>Shared definitions: <code>~/.t3-supervisor/project.yaml</code>, <code>steps/</code>, and <code>workflows/</code> in the T3 server user's home.</p>
    <p>This starts disabled. First enabling creates the shared project.yaml and empty steps/ and workflows/ directories if needed. Existing definitions are preserved, and the files are left uncommitted.</p>
    <p>These definitions supply policy to enabled Supervisors. This switch never activates a chat or changes No Project mode. Disabling them leaves project definitions available; No Project plans use task-local steps.</p>
    <p>Folder detection: {control.detectionStatus}. {control.detectionError}</p></HelpDisclosure>
    <div className="row">
      <button type="button" className={control.enabled ? "danger-button" : "primary"} disabled={busy || blocked} onClick={onToggle}>{busy ? "Saving…" : control.enabled ? "Disable global definitions" : "Enable global definitions"}</button>
      <button type="button" className="quiet-button" title={readAt ? `Last read ${new Date(readAt).toLocaleTimeString()}` : undefined} disabled={busy} onClick={onReload}>Reload global definitions status</button>
    </div><p role="status">{message}</p>
  </section>;
}

export function GlobalDefinitionsControlPanel({refreshKey = 0, onStateChange, active = true}: {active?: boolean; refreshKey?: number; onStateChange?: (activity: ControlActivity) => void}) {
  const registry = useContext(RegistryContext);
  const environmentId = useAtomValue(environmentAtom);
  const stateKey = globalDefinitionsKey(environmentId);
  const epoch = useAtomValue(authEpochAtom, currentEpoch);
  const [state, setState] = useAtom(globalDefinitionsState(stateKey));
  const [revision, setRevision] = useState(0);
  const {control, blocked, message, uncertain} = state;
  const busy = state.toggling !== null;
  useEffect(() => {onStateChange?.({busy, dirty: false, uncertain});}, [busy, uncertain, onStateChange]);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && !busy && !uncertain) setRevision(value => value + 1);
    wasActive.current = active;
  }, [active, busy, uncertain]);
  const readKey = scopeKey(environmentId, revision, refreshKey, epoch);
  const read = useAtomValue(globalDefinitionsRead({environmentId, revision, refreshKey, epoch}));
  useEffect(() => {setState(current => ({...current, control: null}));}, [readKey, setState]);
  useEffect(() => {
    if (AsyncResult.isSuccess(read) && !read.waiting)
      setState(current => ({...current, control: read.value.control, readAt: read.value.readAt, uncertain: false, blocked: false, message: ""}));
    else if (AsyncResult.isFailure(read)) setState(current => ({...current, blocked: true, message: "Global definitions status unavailable. Reload before changing it."}));
  }, [read, setState]);
  if (!control) return <section className="panel"><p role="status">{message || "Loading global definitions status…"}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Reload status</button></section>;
  return <div className="stack"><GlobalDefinitionsControlView readAt={state.readAt} control={control} busy={busy} blocked={blocked} message={message} onReload={() => setRevision(value => value + 1)}
    onToggle={() => startGlobalDefinitionsChange(registry, stateKey)} /></div>;
}
