import {useEffect, useState} from "react";
import {useAtomSet, useAtomValue} from "@effect/atom-react";
import {Effect, Exit, Option} from "effect";
import {KeyValueStore} from "effect/persistence";
import {AsyncResult, Atom, type AtomRegistry} from "effect/reactivity";
import {SupervisionStart, type NoProjectControl, type NoProjectControlInput, type NoProjectModeValue, type SupervisionCandidates, type SupervisionStartStatus} from "../../src/supervisor-control-contract.js";
import {ApiClient, classifyMutation} from "./api.js";
import {admit, admittedMutation, authEpoch, authEpochAtom, environmentAtom, scopeKey, uiRuntime} from "./atoms.js";
import {type ControlActivity} from "./supervisor-control.js";

// a new operation id for one user action
const newOperationId = Effect.sync(() => crypto.randomUUID());

// the typed client with the baseline access refresh on 401 and 403 for every request of these panels
const request = <A, E>(call: (client: ApiClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(ApiClient, (client) => classifyMutation(call(client)));

type NoProjectControlInfo = typeof NoProjectControl.Type;
// the No Project mode panel: the saved control, the mode draft and the outcome of the last read or save
export interface NoProjectState {
  readonly control: NoProjectControlInfo | null;
  readonly mode: NoProjectModeValue;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly message: string;
}
// the panel state, including the mode draft, of each T3 environment
const noProjectStates = Atom.family((_environmentKey: string) =>
  Atom.keepAlive(Atom.make<NoProjectState>({control: null, mode: "on_request", busy: false, uncertain: false, message: ""})));
// the panel state of the current T3 environment
export const noProjectState = Atom.keepAlive(Atom.writable((get) => get(noProjectStates(scopeKey(get(environmentAtom)))),
  (context, value: NoProjectState) => context.set(noProjectStates(scopeKey(context.get(environmentAtom))), value)));
// the state an action works on: the one of the environment it started in, whatever the environment is when it settles
const actionState = (registry: AtomRegistry.AtomRegistry) => {
  const environmentId = registry.get(environmentAtom);
  return {environmentId, state: noProjectStates(scopeKey(environmentId))};
};

// these actions are keep-alive and concurrent, so navigation and auth changes never end them; their requests and waits
// stay interruptible, so disposing the page runtime aborts them, and an interrupted action writes nothing

// reads the saved mode: a read replaces the draft, a failed read keeps it and holds the panel uncertain until a read works
export const reloadNoProject = Atom.keepAlive(uiRuntime.fn((_: void, {registry}) => Effect.gen(function* () {
  const {state: stateAtom} = actionState(registry);
  if (registry.get(stateAtom).busy) return;
  registry.set(stateAtom, {...registry.get(stateAtom), busy: true});
  const exit = yield* Effect.exit(request((client) => client.guidance.noProjectControl()));
  const state = registry.get(stateAtom);
  registry.set(stateAtom, Exit.match(exit, {
    onSuccess: (control) => ({...state, control, mode: control.mode, busy: false, uncertain: false, message: ""}),
    onFailure: () => ({...state, busy: false, uncertain: true, message: "Mode unavailable. Reload before changing it."}),
  }));
}), {concurrent: true}));

const saveNoProjectMode = admittedMutation((payload: NoProjectControlInput) =>
  Effect.flatMap(ApiClient, (client) => client.guidance.saveNoProjectControl({payload})));

// saves the draft against the generation it was read at; an unconfirmed save holds the panel uncertain until a reload
export const saveNoProject = Atom.keepAlive(uiRuntime.fn((_: void, {registry}) => Effect.gen(function* () {
  const {environmentId, state: stateAtom} = actionState(registry);
  const state = registry.get(stateAtom);
  if (!state.control || state.busy || state.uncertain) return;
  registry.set(stateAtom, {...state, busy: true});
  const operation = saveNoProjectMode({scope: scopeKey("no-project-mode", environmentId), operationId: yield* newOperationId});
  const exit = yield* Effect.exit(admit(registry, operation, {expectedGeneration: state.control.generation, mode: state.mode}));
  const latest = registry.get(stateAtom);
  registry.set(stateAtom, Exit.match(exit, {
    onSuccess: (result) => ({...latest, control: result.control, mode: result.control.mode, busy: false, uncertain: result.status !== "saved", message: result.message}),
    onFailure: () => ({...latest, busy: false, uncertain: true, message: "The mode change is unconfirmed. Reload its saved status before trying again."}),
  }));
}), {concurrent: true}));

// the session a hidden panel follows: none
const hiddenEpoch = Atom.keepAlive(Atom.make(AsyncResult.initial<number>()));
// whether the shown panel reads the saved mode now: for a session or environment key it has not read yet, and never over a
// mode draft or a change in flight
export const noProjectReadDue = (panel: {active: boolean; loaded: string | null; readKey: string; dirty: boolean; busy: boolean}) =>
  panel.active && panel.loaded !== panel.readKey && !panel.dirty && !panel.busy;

export function NoProjectPanel({active, onStateChange}: {active: boolean; onStateChange: (value: ControlActivity) => void}) {
  const {control, mode, busy, uncertain, message} = useAtomValue(noProjectState);
  const setState = useAtomSet(noProjectState);
  const reload = useAtomSet(reloadNoProject);
  const save = useAtomSet(saveNoProject);
  const setMode = (value: NoProjectModeValue) => setState((state) => ({...state, mode: value}));
  const dirty = control !== null && mode !== control.mode;
  useEffect(() => onStateChange({busy, uncertain, dirty}), [busy, uncertain, dirty, onStateChange]);
  // the saved mode is read when the panel is first shown and again for a new session or T3 environment, but never over a
  // mode draft or a change in flight; a hidden panel does not follow the session and catches up when it is shown
  const epoch = useAtomValue(active ? authEpochAtom : hiddenEpoch, (result) => Option.getOrElse(AsyncResult.value(result), () => 0));
  const readKey = scopeKey(useAtomValue(environmentAtom), epoch);
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {if (noProjectReadDue({active, loaded, readKey, dirty, busy})) {setLoaded(readKey);reload();}}, [active, loaded, readKey, dirty, busy, reload]);
  return <form className="panel stack" onSubmit={event => {event.preventDefault();save();}}>
    <h2>No Project supervision</h2>
    <p>Choose how chats outside projects receive supervision. The master switch overrides every mode.</p>
    {control && !control.globallyEnabled && <p className="notice">The master switch is off.</p>}
    <fieldset disabled={!control || busy || uncertain}><legend>Activation mode</legend>
      {([ ["off", "Off", "No supervision, including explicit Start requests."], ["on_request", "On request", "Start only the chat you choose. New and replacement chats stay off."], ["automatic", "Automatic", "Follow new requests in every eligible No Project chat."] ] as const).map(([value, label, help]) =>
        <label className="toggle" key={value}><input type="radio" name="noProjectMode" value={value} checked={mode === value} onChange={() => setMode(value)}/><span>{label}<small>{help}</small></span></label>)}
    </fieldset>
    <p className="small muted">On request is the default. Start remains enabled until Stop; a settled Supervisor is only parked. Shared definitions supply policy independently. With shared definitions off, plans use task-local steps.</p>
    <div className="row"><button type="submit" disabled={busy || uncertain || !dirty}>Save No Project mode</button><button type="button" disabled={busy} onClick={() => reload()}>Reload mode</button>{dirty && <button type="button" disabled={busy} onClick={() => setMode(control!.mode)}>Discard mode draft</button>}</div>
    <p role="status">{message}</p>
  </form>;
}

export type ChatCandidates = typeof SupervisionCandidates.Type;
type CandidatePurpose = "start" | "exclude";
// the reload counter of each candidate search
export const candidatesRevision = Atom.family((_purpose: CandidatePurpose) => Atom.keepAlive(Atom.make(0)));
// one candidate search of one T3 environment, requested 200 ms after a typed query and at once for the recent list; a new
// query, purpose or reload is a new search, and the search it replaces is interrupted with its pending delay or request; a
// new session searches again
const environmentSearches = Atom.family((_environmentKey: string) => Atom.family((purpose: CandidatePurpose) => Atom.family((query: string) =>
  Atom.family((_revision: number) => uiRuntime.atom((get) => {
    authEpoch(get);
    return (query ? Effect.sleep("200 millis") : Effect.void).pipe(
      Effect.andThen(request((client) => client.guidance.supervisionCandidates({query: {query, purpose}}))));
  })))));
// the candidate search of the current T3 environment: another environment's rows are never shown, so while the new
// environment's search is unread or failed there is no row to act on
export const chatCandidates = Atom.family((purpose: CandidatePurpose) => Atom.family((query: string) => Atom.family((revision: number) =>
  Atom.make((get) => get(environmentSearches(scopeKey(get(environmentAtom)))(purpose)(query)(revision))))));
// the search of an inactive panel: nothing is requested
const noCandidates = Atom.keepAlive(Atom.make(AsyncResult.initial<ChatCandidates>()));

export function useChatCandidates(query: string, purpose: CandidatePurpose, active = true) {
  const revision = useAtomValue(candidatesRevision(purpose));
  const setRevision = useAtomSet(candidatesRevision(purpose));
  const result = useAtomValue<AsyncResult.AsyncResult<ChatCandidates, unknown>>(active ? chatCandidates(purpose)(query)(revision) : noCandidates);
  return {data: AsyncResult.isSuccess(result) ? result.value : null, error: AsyncResult.isFailure(result) ? "Chat search unavailable. Reload to try again." : "",
    reload: () => setRevision(value => value + 1)};
}

type StartIntent = typeof SupervisionStart.Type;
// the Start fence: one retained intent per tab in sessionStorage, written before the request and cleared only by a
// terminal status
const startIntentKey = "supervisor-pending-start";
const sessionStore = KeyValueStore.layerStorage(() => sessionStorage);
const startFence = <A, E>(use: (fence: KeyValueStore.SchemaStore<typeof SupervisionStart>) => Effect.Effect<A, E>) =>
  Effect.flatMap(KeyValueStore.KeyValueStore, (store) => use(KeyValueStore.toSchemaStore(store, SupervisionStart))).pipe(Effect.provide(sessionStore));
// the intent retained when the page opened; storage that is blocked or holds an invalid entry retains none
const retainedStart = Atom.make(startFence((fence) => fence.get(startIntentKey)).pipe(Effect.catchCause(() => Effect.succeedNone)));

export interface StartState {
  readonly intent: StartIntent | null;
  readonly busy: boolean;
  readonly message: string;
}
export const startState = Atom.keepAlive(Atom.writable(
  (get): StartState => ({intent: Option.getOrNull(Option.flatten(AsyncResult.value(get(retainedStart)))), busy: false, message: ""}),
  (context, value: StartState) => context.setSelf(value)));

const startMutation = admittedMutation((payload: StartIntent) => Effect.flatMap(ApiClient, (client) => client.guidance.startSupervision({payload})));

// applies a status to the intent it answers: a status for another intent is a failure, a terminal status clears the fence
// once, and a "denied" read is never terminal because the original request may still be running; true when cleared. the
// fence removal and the state that records it form one uninterruptible step without any wait
const applyStartStatus = (registry: AtomRegistry.AtomRegistry, exit: Exit.Exit<typeof SupervisionStartStatus.Type, unknown>, intent: StartIntent, fromRead: boolean, failure: string) => Effect.uninterruptible(Effect.gen(function* () {
  const state = registry.get(startState);
  if (Exit.isFailure(exit) || exit.value.threadId !== intent.threadId || exit.value.operationId !== intent.operationId) {
    registry.set(startState, {...state, busy: false, message: failure});
    return false;
  }
  const status = exit.value;
  if (status.status === "pending" || fromRead && status.status === "denied") {
    registry.set(startState, {...state, busy: false, message: status.reason});
    return false;
  }
  const removed = yield* Effect.exit(startFence((fence) => fence.remove(startIntentKey)));
  if (Exit.isFailure(removed)) {
    registry.set(startState, {...state, busy: false, message: failure});
    return false;
  }
  registry.set(startState, {intent: null, busy: false, message: status.reason});
  registry.set(candidatesRevision("start"), registry.get(candidatesRevision("start")) + 1);
  return true;
}));

// starts supervision of one chat: the fence is persisted before the request, and no Start is sent without it; an unknown
// outcome keeps the fence, and nothing sends another Start until a terminal status clears it; true when cleared. the
// persistence and the state that records it form one uninterruptible step; an action interrupted while it waits leaves
// the persisted fence with its original operation id for the next page, which never sends the Start again
export const startSupervision = Atom.keepAlive(uiRuntime.fn((threadId: string, {registry}) => Effect.gen(function* () {
  const state = registry.get(startState);
  if (state.busy || state.intent) return false;
  const intent = {threadId, operationId: yield* newOperationId};
  const persisted = yield* Effect.uninterruptible(Effect.exit(startFence((fence) => fence.set(startIntentKey, intent))).pipe(
    Effect.tap((stored) => Exit.isSuccess(stored) ? Effect.sync(() => registry.set(startState, {intent, busy: true, message: "Saving Start…"})) : Effect.void)));
  if (Exit.isFailure(persisted)) return false;
  const exit = yield* Effect.exit(admit(registry, startMutation({scope: scopeKey("start-supervision"), operationId: intent.operationId}), intent));
  return yield* applyStartStatus(registry, exit, intent, false, "Start outcome is unknown. Check the original operation status; no new Start will be sent.");
}), {concurrent: true}));

// reads the status of the exact retained operation; true when it cleared the fence
export const checkStartStatus = Atom.keepAlive(uiRuntime.fn((_: void, {registry}) => Effect.gen(function* () {
  const state = registry.get(startState);
  if (state.busy || !state.intent) return false;
  const intent = state.intent;
  registry.set(startState, {...state, busy: true});
  const exit = yield* Effect.exit(request((client) => client.guidance.supervisionStartStatus({query: intent})));
  return yield* applyStartStatus(registry, exit, intent, true, "Start status unavailable. The original operation remains held.");
}), {concurrent: true}));

export function StartSupervisionPanel({active, onStateChange, onChanged}: {active: boolean; onStateChange: (value: boolean) => void; onChanged: () => void}) {
  const [query, setQuery] = useState("");const candidates = useChatCandidates(query, "start", active);
  const {intent, busy, message} = useAtomValue(startState);
  const start = useAtomSet(startSupervision, {mode: "promiseExit"});
  const check = useAtomSet(checkStartStatus, {mode: "promiseExit"});
  useEffect(() => onStateChange(busy || intent !== null), [busy, intent, onStateChange]);
  // the shell refreshes its snapshot after a Start settles
  const settled = async (outcome: Promise<Exit.Exit<boolean, unknown>>) => {const exit = await outcome;if (Exit.isSuccess(exit) && exit.value) onChanged();};
  return <section hidden={!active} className="panel stack" aria-labelledby="start-supervision-heading">
    <details><summary id="start-supervision-heading">Start supervision for a No Project chat</summary><div className="stack"><p>Choose a recent chat, search by title or ID, or paste its T3 link. Start stays enabled until explicit Stop.</p>
    <label htmlFor="start-chat-search">Find a chat</label><input id="start-chat-search" type="search" value={query} maxLength={512} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-describedby="start-chat-help" onChange={event => setQuery(event.target.value)}/>
    <p id="start-chat-help" className="small muted">{candidates.error || candidates.data?.message || "Loading recent chats…"}</p>
    {candidates.error && <button type="button" onClick={candidates.reload}>Reload chat search</button>}
    <ul className="candidate-list">{candidates.data?.candidates.map(chat => <li key={chat.id} className="row between"><div><strong>{chat.title}</strong><p className="small muted">{chat.id}{chat.active ? " · Started" : chat.excluded ? " · Stopped" : ""}</p></div><button type="button" disabled={busy || intent !== null || chat.active} aria-label={`Start supervision for ${chat.title}`} onClick={() => void settled(start(chat.id))}>{chat.active ? "Started" : "Start supervision"}</button></li>)}</ul>
    {intent && <div className="notice stack"><p>Retained Start for <code>{intent.threadId}</code></p><button type="button" disabled={busy} onClick={() => void settled(check())}>Check Start status</button></div>}
    <p role="status">{message}</p>
    </div></details>
  </section>;
}
