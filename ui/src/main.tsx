import {activityTitle} from "./activity-presentation.js";
import {NoProjectPanel, StartSupervisionPanel, useChatCandidates} from "./no-project.js";
import { SessionAccess } from "./access.js";
import { Fragment, useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  RegistryProvider,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Effect, Exit, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type {
  GuidanceActivity,
  GuidanceSnapshot,
} from "../../src/guidance-contract.js";
import type { ThreadPolicySettings } from "../../src/thread-policy-contract.js";
import {
  ApiClient,
  sessionHttpClient,
} from "./api.js";
import { admit, admittedMutation, authEpoch, authEpochAtom, draftFamily, environmentAtom, scopeKey, snapshotAtom, refreshOnDashboardChange, uiRuntime, type MutationKey } from "./atoms.js";
import { themeAtom, ThemeSelector } from "./theme.js";
import "./style.css";
import { directoryRoute, homeRoute, RouteLink, useNavigation, type Route } from "./navigation.js";
import { Home, useOverview } from "./overview.js";
import { Icon } from "./icons.js";
import { ProjectDefinitionsPanel } from "./project-definitions.js";
import { StepsAndWorkflowsGuide } from "./steps-and-workflows-guide.js";
import { idleControlActivity, SupervisionControlPanel, GlobalDefinitionsControlPanel } from "./supervisor-control.js";

// a new operation id for one user action
const newOperationId = Effect.sync(() => crypto.randomUUID());

// committed changes refresh the existing typed snapshot without replacing its retained success or failure
export const dashboardSnapshot = snapshotAtom.pipe(refreshOnDashboardChange("snapshot"));

// what the shell shows for a snapshot: the current or last successful snapshot (disconnected while failing), and the
// alert that keeps drafts while the read fails
export const snapshotView = (snapshot: AsyncResult.AsyncResult<GuidanceSnapshot, unknown>) => {
  const last = AsyncResult.value(snapshot);
  return {
    data: AsyncResult.isSuccess(snapshot) ? snapshot.value : Option.getOrNull(Option.map(last, (value) => ({...value, connected: false}))),
    connected: AsyncResult.isSuccess(snapshot) && snapshot.value.connected,
    alert: AsyncResult.isFailure(snapshot) && Option.isSome(last) ? "Supervisor connection unavailable. Your drafts are kept." : "",
  };
};

// the moments the baseline shell refreshed access: when the snapshot starts failing and when T3 reconnects
const accessRefreshes = Atom.make((get) => {
  const snapshot = get(snapshotAtom);
  const failing = AsyncResult.isFailure(snapshot);
  const connected = AsyncResult.isSuccess(snapshot) && snapshot.value.connected;
  const previous = get.self<{readonly failing: boolean; readonly connected: boolean; readonly count: number}>();
  const count = Option.match(previous, {
    onNone: () => failing ? 1 : 0,
    onSome: (before) => before.count + (failing && !before.failing || !before.connected && connected ? 1 : 0),
  });
  return {failing, connected, count};
});
const accessRefreshCount = Atom.map(accessRefreshes, (refreshes) => refreshes.count);
export const accessRefresh = uiRuntime.atom((get) =>
  get(accessRefreshCount) === 0 ? Effect.void : Effect.flatMap(SessionAccess, (access) => access.load));
// the Retry of the connecting screen: refresh access, then the snapshot
const retryAccess = uiRuntime.fn((_: void, {registry}) => Effect.flatMap(SessionAccess, (access) => access.load).pipe(
  Effect.andThen(Effect.sync(() => registry.refresh(snapshotAtom)))));

export type AccessState = "signedIn" | "signedOut" | "unreachable";
// the access check of the stored session, repeated whenever the session changes (sign-in, sign-out, another tab,
// expiry); a check without a session sends nothing, and the epoch tells a check after a sign-in from one before it
export const accessAtom = uiRuntime.atom((get) => {
  const epoch = authEpoch(get);
  return Effect.gen(function* () {
    const access = yield* SessionAccess;
    if (!(yield* access.session)) return {epoch, state: "signedOut" as AccessState};
    const authenticated = yield* access.check;
    return {epoch, state: (authenticated ? "signedIn" : "signedOut") as AccessState};
  }).pipe(Effect.catchTag("AccessUnreachable", () => Effect.succeed({epoch, state: "unreachable" as AccessState})));
});
const currentEpoch = (registry: AtomRegistry.AtomRegistry) => Option.getOrElse(AsyncResult.value(registry.get(authEpochAtom)), () => 0);
// the first settled access check made after the given auth epoch
const accessAfter = (epoch: number) => Atom.toStream(accessAtom).pipe(
  Stream.filter((result) => AsyncResult.isSuccess(result) && !result.waiting && result.value.epoch > epoch),
  Stream.runHead,
  Effect.map((result) => Option.match(Option.flatMap(result, AsyncResult.value), {onNone: (): AccessState => "unreachable", onSome: (access) => access.state})));

// sign-in and sign-out requests go through the dashboard's session client outside the SupervisorApi groups; the request
// and its response belong to the enclosing scope, so every return, failure or interruption aborts and releases them
const authRequest = (path: string, body: object) => Effect.flatMap(HttpClient.HttpClient, (client) =>
  HttpClient.withScope(client).execute(HttpClientRequest.post(new URL(path, globalThis.location.origin)).pipe(HttpClientRequest.bodyJsonUnsafe(body))));
const LoginResult = Schema.Struct({session: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u))});
type LoginOutcome = "stored" | "rejected" | "refused" | "unreachable" | "storageBlocked";
// one sign-in with a single-use token: the returned session is stored even when the form is gone
const login = admittedMutation((token: string) => Effect.scoped(Effect.gen(function* () {
  const response = yield* authRequest("/auth/login", {token});
  if (response.status < 200 || response.status > 299) return (response.status === 401 ? "rejected" : "refused") as LoginOutcome;
  const {session} = yield* HttpClientResponse.schemaBodyJson(LoginResult)(response);
  yield* Effect.flatMap(SessionAccess, (access) => access.signIn(session));
  return "stored" as LoginOutcome;
})).pipe(
  Effect.catchTag("StorageBlocked", () => Effect.succeed("storageBlocked" as LoginOutcome)),
  Effect.catch(() => Effect.succeed("unreachable" as LoginOutcome)),
  Effect.provide(sessionHttpClient)));
const loginMessages: Record<Exclude<LoginOutcome, "stored">, string> = {
  rejected: "The sign-in token is invalid, expired or already used.",
  refused: "Could not sign in. Try again.",
  unreachable: "Could not reach Supervisor. Try again.",
  storageBlocked: "Your browser blocked saved sign-in. Allow site storage for Supervisor and try again.",
};

// the sign-in form outside its token, which never leaves the form
export interface SignInState {
  readonly busy: boolean;
  readonly error: string;
}
export const signInState = Atom.keepAlive(Atom.make<SignInState>({busy: false, error: ""}));
// the outcome of one sign-in: it waits for the admitted login and then for the access check of the stored session; once
// the login's outcome is applied the operation is reset, so no atom keeps the consumed token as its argument. the keep-alive
// concurrent action outlives the form and the page's navigation; its waits stay interruptible, so disposing the page
// runtime ends them, and an interrupted action writes nothing
const signInOutcome = Atom.keepAlive(uiRuntime.fn((attempt: {readonly key: MutationKey; readonly epoch: number}, {registry}) => Effect.gen(function* () {
  const operation = login(attempt.key);
  const exit = yield* Effect.exit(AtomRegistry.getResult(registry, operation, {suspendOnWaiting: true}));
  registry.set(operation, Atom.Reset);
  const outcome: LoginOutcome = Exit.isSuccess(exit) ? exit.value : "unreachable";
  if (outcome !== "stored") {
    registry.set(signInState, {busy: false, error: loginMessages[outcome]});
    return false;
  }
  const access = yield* accessAfter(attempt.epoch);
  registry.set(signInState, {busy: false, error: access === "signedIn" ? "" : access === "unreachable" ? loginMessages.unreachable : "Sign-in could not be confirmed. Try again."});
  return true;
}), {concurrent: true}));
// signs in with a token and waits for the access check of the stored session; true once the session is stored. the
// token goes only to the admitted login, which is reset once its outcome is applied; nothing else keeps it
export const signInAction = Atom.keepAlive(Atom.writable((get) => get(signInOutcome), (context, token: string) => {
  if (context.get(signInState).busy) return;
  context.set(signInState, {busy: true, error: ""});
  const attempt = {key: {scope: scopeKey("sign-in"), operationId: crypto.randomUUID()}, epoch: Option.getOrElse(AsyncResult.value(context.get(authEpochAtom)), () => 0)};
  context.set(login(attempt.key), token);
  context.set(signInOutcome, attempt);
}));

type LogoutOutcome = "signedOut" | "kept" | "failed";
// one sign-out: the server session ends, and this tab forgets it unless another tab signed in meanwhile
const logout = admittedMutation((_: void) => Effect.scoped(Effect.gen(function* () {
  const access = yield* SessionAccess;
  const session = yield* access.session;
  const response = yield* authRequest("/auth/logout", {});
  if (response.status < 200 || response.status > 299) return "failed" as LogoutOutcome;
  if ((yield* access.session) !== session) return "kept" as LogoutOutcome;
  yield* access.clear(session);
  return "signedOut" as LogoutOutcome;
})).pipe(Effect.catch(() => Effect.succeed("failed" as LogoutOutcome)), Effect.provide(sessionHttpClient)));
// explicit sign-outs; the dashboard opened before one is closed
const signOutCount = Atom.keepAlive(Atom.make(0));
const signingOut = Atom.keepAlive(Atom.make(false));
// signs out once however often it is asked while it runs; after a sign-out the dashboard closes once access shows it. the
// request and every wait stay interruptible, so disposing the page runtime ends them
export const signOutAction = Atom.keepAlive(uiRuntime.fn((_: void, {registry}) => Effect.gen(function* () {
  if (registry.get(signingOut)) return "kept" as LogoutOutcome;
  registry.set(signingOut, true);
  const epoch = currentEpoch(registry);
  const exit = yield* Effect.exit(admit(registry, logout({scope: scopeKey("sign-out"), operationId: yield* newOperationId}), undefined));
  const outcome: LogoutOutcome = Exit.isSuccess(exit) ? exit.value : "failed";
  if (outcome === "signedOut") {
    yield* accessAfter(epoch);
    registry.set(signInState, {busy: false, error: ""});
    registry.set(signOutCount, registry.get(signOutCount) + 1);
  }
  registry.set(signingOut, false);
  return outcome;
}), {concurrent: true}));

// whether the dashboard is open: from the first signed-in check until an explicit sign-out; it stays mounted (hidden)
// while the session is missing, so open drafts survive expiry and re-sign-in
export const dashboardOpened = Atom.keepAlive(Atom.make((get) => {
  const generation = get(signOutCount);
  const access = get(accessAtom);
  const previous = Option.filter(get.self<{readonly generation: number; readonly opened: boolean}>(), (before) => before.generation === generation);
  return {generation, opened: Option.exists(previous, (before) => before.opened) || AsyncResult.isSuccess(access) && access.value.state === "signedIn"};
}));

const labels: Record<string, string> = {
  observe: "Observe only",
  paused: "Paused",
  send: "Send guidance",
  observe_only: "Observe only",
  no_match: "No match",
  needs_context: "Needs context",
  not_supervised: "Supervision not needed",
  uncertain: "Delivery uncertain",
  sent: "Confirmed sent",
  visible: "Visible in chat",
  accepted: "Accepted by T3",
  rejected: "Rejected",
  not_deliverable: "Not deliverable",
  delivered_later_run: "Delivered to a later run",
};
const label = (value: string) => labels[value] ?? value.replaceAll("_", " ");
function History({
  items,
  title, data, navigate,
}: {
  items: ReadonlyArray<GuidanceActivity>;
  title: string; data: GuidanceSnapshot; navigate: (route: Route) => void;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GuidanceActivity | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const inspect = (item: GuidanceActivity) => {setSelected(item);dialog.current?.showModal();};
  return (
    <section>
      <div className="toolbar">
        <div>
          <h1>{title}</h1>
          <p className="muted">A chronological record of supervision decisions and delivery. These are historical events, not an unresolved issue list.</p>
        </div>
        <label className="search">
          Filter activity
          <input
            aria-label="Filter activity"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="State, chat ID or reason"
          />
        </label>
      </div>
      <div className="panel audit">
        {[...items].filter(item => JSON.stringify(item).toLowerCase().includes(filter.toLowerCase())).sort((a, b) => b.createdAt - a.createdAt).map((item, index, rows) => {
          const thread = data.threads.find(thread => thread.id === item.threadId);
          const day = new Date(item.createdAt).toLocaleDateString();
          return <Fragment key={item.id}>
            {(index === 0 || new Date(rows[index - 1]!.createdAt).toLocaleDateString() !== day) && <h2 className="activity-day">{day}</h2>}
            <article><div><strong>{activityTitle(item)}</strong><p>{thread?.projectId ? <RouteLink to={{...directoryRoute, projectId: thread.projectId, main: thread.id, section: "task"}} navigate={navigate}>{thread.title}</RouteLink> : "Supervisor"}</p><small className="muted"><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleTimeString()}</time></small></div><button type="button" onClick={() => inspect(item)}>Inspect</button></article>
          </Fragment>;
        })}
        {!items.some(item => JSON.stringify(item).toLowerCase().includes(filter.toLowerCase())) && (
          <p className="muted">{items.length ? "No activity matches this filter." : "No retained activity yet."}</p>
        )}
      </div>
      <dialog ref={dialog} aria-labelledby="detail-title">
        <div className="row between">
          <h2 id="detail-title">
            {selected ? label(selected.kind) : "Activity"}
          </h2>
          <button onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <p>{selected ? label(selected.state) : ""}</p>
        <pre>
          {selected?.detail ??
            "Detailed evidence was not retained or has expired."}
        </pre>
        <p className="muted">
          Run: {selected?.runId ?? "Not available"} · Rule:{" "}
          {selected?.ruleId ?? "Not applicable"}
        </p>
        {selected?.threadId && (
          <a href={`t3-thread://v1/${selected.threadId}`}>
            Open originating chat
          </a>
        )}
      </dialog>
    </section>
  );
}
// the chat settings of each T3 environment: the draft, null while the form follows the saved policy, and the outcome of
// the last save; the shown ones are those of the current environment. uncertain: the last save's outcome is unknown, so
// nothing is saved again until a verified read of the settings
type ChatSettingsStatus = {readonly saving: boolean; readonly uncertain: boolean; readonly message: string};
const chatSettingsKey = (environmentId: string | null) => scopeKey("chat-settings", environmentId);
const chatSettingsDrafts = draftFamily<ThreadPolicySettings | null>(() => null);
const chatSettingsStatuses = Atom.family((_key: string) => Atom.keepAlive(Atom.make<ChatSettingsStatus>({saving: false, uncertain: false, message: ""})));
const chatSettingsRefused = "Chat settings invalid or changed in another tab. Reload first.";
export const chatSettingsDraft = Atom.keepAlive(Atom.writable((get) => get(chatSettingsDrafts(chatSettingsKey(get(environmentAtom)))),
  (context, value: ThreadPolicySettings | null) => context.set(chatSettingsDrafts(chatSettingsKey(context.get(environmentAtom))), value)));
export const chatSettingsStatus = Atom.keepAlive(Atom.writable((get) => get(chatSettingsStatuses(chatSettingsKey(get(environmentAtom)))),
  (context, value: ChatSettingsStatus) => context.set(chatSettingsStatuses(chatSettingsKey(context.get(environmentAtom))), value)));
const saveThreadPolicy = admittedMutation((payload: ThreadPolicySettings) => Effect.flatMap(ApiClient, (client) => client.guidance.threadPolicy({payload})));
// saves the draft of the current environment; a verified save clears it and refreshes the snapshot, a failed or
// unconfirmed save keeps it, and an unconfirmed one also fences the settings until a verified read. the outcome goes to
// the environment the save started in, never to the one shown when it settles; the request and every wait stay
// interruptible, so disposing the page runtime ends them
export const saveChatSettings = Atom.keepAlive(uiRuntime.fn((payload: ThreadPolicySettings, {registry}) => Effect.gen(function* () {
  const key = chatSettingsKey(registry.get(environmentAtom));
  const status = chatSettingsStatuses(key);
  if (registry.get(status).saving || registry.get(status).uncertain) return;
  registry.set(status, {...registry.get(status), saving: true});
  const exit = yield* Effect.exit(admit(registry, saveThreadPolicy({scope: key, operationId: yield* newOperationId}), payload));
  if (Exit.isSuccess(exit)) {
    registry.set(chatSettingsDrafts(key), null);
    registry.set(status, {saving: false, uncertain: false, message: "Chat settings saved and applied."});
    registry.refresh(snapshotAtom);
  } else {
    const failure = Exit.findErrorOption(exit);
    const uncertain = Option.isSome(failure) && failure.value._tag === "Unconfirmed";
    registry.set(status, {saving: false, uncertain, message: chatSettingsRefused});
  }
}), {concurrent: true}));
const sameExclusions = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
// reads the settings of the current environment again; only a verified read of that environment lifts the fence of an
// unconfirmed save. a draft the saved settings already match was applied and is cleared; any other draft is kept
export const reloadChatSettings = Atom.keepAlive(uiRuntime.fn((_: void, {registry}) => Effect.gen(function* () {
  const key = chatSettingsKey(registry.get(environmentAtom));
  const status = chatSettingsStatuses(key);
  registry.refresh(snapshotAtom);
  const read = yield* AtomRegistry.getResult(registry, snapshotAtom, {suspendOnWaiting: true});
  if (chatSettingsKey(read.environmentId) !== key) return;
  const draft = registry.get(chatSettingsDrafts(key));
  const applied = draft !== null && sameExclusions(draft.excludedThreadIds, read.threadPolicy.excludedThreadIds);
  if (applied) registry.set(chatSettingsDrafts(key), null);
  registry.set(status, {saving: false, uncertain: false, message: applied ? "Chat settings saved and applied." : ""});
}).pipe(Effect.catch(() => Effect.void))));
function ChatSettings({ data, onDirtyChange }: { data: GuidanceSnapshot; onDirtyChange: (dirty: boolean) => void }) {
  const draft = useAtomValue(chatSettingsDraft);
  const setDraft = useAtomSet(chatSettingsDraft);
  const {saving, uncertain, message} = useAtomValue(chatSettingsStatus);
  const setStatus = useAtomSet(chatSettingsStatus);
  const save = useAtomSet(saveChatSettings);
  const reload = useAtomSet(reloadChatSettings);
  const form = draft ?? data.threadPolicy;
  const dirty = draft !== null;
  const [query, setQuery] = useState("");
  const setMessage = (value: string) => setStatus(status => ({...status, message: value}));
  useEffect(() => onDirtyChange(dirty || saving || uncertain), [dirty, saving, uncertain, onDirtyChange]);
  const candidates = useChatCandidates(query, "exclude");
  const searchRef = useRef<HTMLInputElement>(null);
  const chats = form.excludedThreadIds.filter(id => (candidates.data?.exceptions.includes(id) || !data.threadPolicy.excludedThreadIds.includes(id))).map(id => data.threads.find(thread => thread.id === id) ?? {id, title: "Unavailable chat", available: false});
  const change = (patch: Partial<typeof form>) => { setDraft({ ...form, ...patch }); setMessage(""); };
  return <form className="panel stack" method="post" onSubmit={event => {
    event.preventDefault(); save(form);
  }}>
    <h2>Chat exclusions</h2>
    <p>Saved for this Supervisor instance. Changes apply without restarting.</p>
    <fieldset><legend>Excluded chats</legend>
      <p>Project Supervisors skip excluded chats. Existing project, workflow and conversation state is retained.</p>
      <p>Only explicit exclusions in enabled scopes appear here. Hidden or unavailable exclusions stay saved.</p>
      <ul className="candidate-list">{chats.map(chat => <li key={chat.id} className="row between"><div><strong>{chat.title}</strong><p className="small muted">{chat.id}</p></div><button type="button" disabled={saving} aria-label={`Remove exclusion for ${chat.title}`} onClick={() => {change({excludedThreadIds: form.excludedThreadIds.filter(id => id !== chat.id)});searchRef.current?.focus();}}>Remove exclusion</button></li>)}</ul>
      {!chats.length && candidates.data && <p>No explicit exclusions in enabled scopes.</p>}
      <label htmlFor="chat-search">Add an exclusion</label><input ref={searchRef} id="chat-search" name="chatSearch" type="search" value={query} maxLength={512} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={saving} aria-describedby="exclusion-help" onChange={e => setQuery(e.target.value)} />
      <p id="exclusion-help" className="small muted">{candidates.error || (query ? candidates.data?.message : "Search for a chat title, ID or native T3 link.")}</p>
      {candidates.error && <button type="button" onClick={candidates.reload}>Reload exclusion search</button>}
      {query && <ul className="candidate-list">{candidates.data?.candidates.filter(chat => !form.excludedThreadIds.includes(chat.id)).map(chat => <li key={chat.id} className="row between"><div><strong>{chat.title}</strong><p className="small muted">{chat.id}</p></div><button type="button" disabled={saving} aria-label={`Add exclusion for ${chat.title}`} onClick={() => {change({excludedThreadIds: [...form.excludedThreadIds, chat.id]});setQuery("");searchRef.current?.focus();}}>Add exclusion</button></li>)}</ul>}
      <small>{form.excludedThreadIds.length} exclusions retained in total.</small>
    </fieldset>
    <div className="save-bar">{dirty && <span>Unsaved chat exclusions</span>}<button className="primary" disabled={saving || uncertain || !dirty} type="submit">{saving ? "Saving…" : "Save chat settings"}</button>{uncertain && <button type="button" onClick={() => reload()}>Reload chat settings</button>}{dirty && <button type="button" disabled={saving} onClick={() => {setDraft(null);setMessage("");}}>Discard draft</button>}</div><p role="status">{message}</p>
  </form>;
}
function Settings({data, active, onDirtyChange}: {data: GuidanceSnapshot; active: boolean; onDirtyChange: (dirty: boolean) => void}) {
  const [controlRevision, setControlRevision] = useState(0);
  const [chatDirty, setChatDirty] = useState(false);
  const [masterActivity, setMasterActivity] = useState(idleControlActivity);
  const [definitionsActivity, setDefinitionsActivity] = useState(idleControlActivity);
  const [noProjectActivity, setNoProjectActivity] = useState(idleControlActivity);
  useEffect(() => onDirtyChange(noProjectActivity.busy || noProjectActivity.dirty || noProjectActivity.uncertain || chatDirty || masterActivity.busy || masterActivity.uncertain || definitionsActivity.busy || definitionsActivity.uncertain), [noProjectActivity, chatDirty, masterActivity, definitionsActivity, onDirtyChange]);
  return <section className="stack settings-workspace"><div className="page-heading"><h1>Instance settings</h1><p className="muted">Controls shared across this Supervisor installation. Project defaults live with each project.</p><p className="connection-summary"><span className={`dot ${data.connected ? "online" : ""}`}/>{data.connected ? "T3 connected" : "T3 disconnected"}</p></div><ThemeSelector/><section className="settings-group stack"><h2>Where supervision runs</h2><SupervisionControlPanel active={active} onStateChange={setMasterActivity} onChanged={() => setControlRevision(value => value + 1)} /><NoProjectPanel active={active} onStateChange={setNoProjectActivity}/><GlobalDefinitionsControlPanel active={active} refreshKey={controlRevision} onStateChange={setDefinitionsActivity}/></section><section className="settings-group stack"><h2>Exceptions for individual chats</h2><ChatSettings data={data} onDirtyChange={setChatDirty}/></section>
    <div className="panel stack"><h2>T3 connection</h2><p>{data.connected ? "Connected" : "Disconnected"} · Build: {data.serverVersion ?? "Unavailable"}</p><p>{data.coverage}</p>
      <details><summary>Advanced connection and editing details</summary><div className="stack"><h3>Project configuration editing</h3><p>Configure a dedicated credential with filesystem:read and filesystem:write at T3_PROJECT_WRITE_TOKEN_FILE through deployment setup. The editor writes only .t3-supervisor/project.yaml in the selected working directory. Step and workflow definitions are read-only in the dashboard.</p>
      <p>Native dialogue can record plan proposals and agreement; those records do not prove step execution.</p></div></details>
    </div></section>;
}
// the Sign out control: blocked while a draft or pending change exists, so explicit sign-out never discards one
export function SignOutButton({blocked, onSignOut}: {blocked: boolean; onSignOut: () => void}) {
  return <button className="quiet-button" disabled={blocked} aria-describedby={blocked ? "pending-changes" : undefined} title={blocked ? "Save drafts and resolve pending changes before signing out." : undefined} onClick={onSignOut}>Sign out</button>;
}
function Dashboard({onSignedOut}: {onSignedOut: () => void}) {
  const [signOutError, setSignOutError] = useState("");
  const [startPending, setStartPending] = useState(false);
  const snapshot = useAtomValue(dashboardSnapshot);
  const refresh = useAtomRefresh(snapshotAtom);
  useAtomMount(accessRefresh);
  const retry = useAtomSet(retryAccess);
  const signOut = useAtomSet(signOutAction, {mode: "promiseExit"});
  const {route, navigate, guard} = useNavigation();
  const view = route.page;
  useEffect(() => { document.title = `${route.projectId ? "Project" : route.page[0]!.toUpperCase() + route.page.slice(1)} · Supervisor`; }, [route]);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsOpened, setSettingsOpened] = useState(view === "settings");
  useEffect(() => { if (view === "settings") setSettingsOpened(true); }, [view]);
  const [projectDirty, setProjectDirty] = useState(false);
  const [projectDraftTarget, setProjectDraftTarget] = useState<Route | null>(null);
  const {data, connected, alert} = snapshotView(snapshot);
  const overview = useOverview(true, connected);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (startPending || projectDirty || settingsDirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [startPending, projectDirty, settingsDirty]);
  if (!data)
    return (
      <div className="app-shell">
        <aside className="app-sidebar"><span className="app-name"><img src="/app-icon.png" width="36" height="36" alt=""/><span>Supervisor<span className="app-name-detail">Keep work in view</span></span></span></aside>
        <div className="app-body"><main id="workspace" tabIndex={-1} className="boot-state stack">
          {snapshot._tag === "Failure"
            ? <><h1>Supervisor is unavailable</h1><p className="muted">The Supervisor connection could not be read. Your session is kept.</p><div><button className="primary" onClick={() => retry()}>Retry</button></div></>
            : <><h1 className="sr-only">Supervisor</h1><div className="loading-state" role="status"><div className="skeleton"/><div className="skeleton"/><p>Connecting to Supervisor…</p></div></>}
        </main></div>
      </div>
    );
  const dirty = startPending || projectDirty || settingsDirty;
  const signOutNow = async () => {
    const exit = await signOut();
    const outcome = Exit.isSuccess(exit) ? exit.value : "failed";
    if (outcome === "failed") setSignOutError("Could not sign out. Try again.");
    else if (outcome === "signedOut") onSignedOut();
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace" onClick={event => {event.preventDefault();document.getElementById("workspace")?.focus();}}>Skip to content</a>
      <aside className="app-sidebar">
        <RouteLink to={homeRoute} navigate={navigate} className="app-name"><img src="/app-icon.png" width="36" height="36" alt=""/><span>Supervisor<span className="app-name-detail">Keep work in view</span></span></RouteLink>
        <nav className="app-nav" aria-label="Supervisor sections">
          {(["home", "projects", "activity", "settings"] as const).map(name => <RouteLink key={name} to={{...directoryRoute, page: name}} navigate={navigate} aria-current={view === name ? "page" : undefined}><Icon name={name}/><span>{name[0]!.toUpperCase() + name.slice(1)}</span>{name === "settings" && settingsDirty && <span className="draft-dot" aria-label="Unsaved changes" />}{name === "home" && Boolean(overview.data?.attentionTotal) && <span className="nav-count">{overview.data!.attentionTotal}</span>}</RouteLink>)}
        </nav>
        <nav className="sidebar-utility" aria-label="Reference"><RouteLink to={{...directoryRoute, page: "guide"}} navigate={navigate} aria-current={view === "guide" ? "page" : undefined}><Icon name="guide"/>Guide</RouteLink></nav>
      </aside>
      <div className="app-body">
      <header className="app-header"><div className="environment-context"><span className="environment-label">Supervisor instance</span><span className="connection"><span className={`dot ${data.connected ? "online" : ""}`} />{data.connected ? "T3 connected" : "Disconnected"}</span>{overview.data && <span className="small muted">Supervision {overview.data.globallyEnabled ? "on" : "off globally"}</span>}</div><div className="row"><SignOutButton blocked={dirty} onSignOut={() => void signOutNow()}/></div></header>
      <main id="workspace" tabIndex={-1}>
        {dirty && <p id="pending-changes" className="notice" role="status">Save drafts and resolve pending changes before signing out. {projectDirty && projectDraftTarget && <RouteLink to={projectDraftTarget} navigate={navigate}>Review project changes</RouteLink>}{projectDirty && settingsDirty && " · "}{settingsDirty && <RouteLink to={{...directoryRoute, page: "settings"}} navigate={navigate}>Review instance settings</RouteLink>}</p>}
        {signOutError && <p className="notice" role="alert">{signOutError}</p>}
        {alert && <p className="notice" role="alert">{alert}</p>}
        <div hidden={view !== "home"}><Home data={data} overview={overview} navigate={navigate} startPanel={<StartSupervisionPanel active={view === "home"} onStateChange={setStartPending} onChanged={refresh}/>}/></div>
        <div hidden={view !== "projects"}><ProjectDefinitionsPanel data={data} overview={overview} route={route} navigate={navigate} guard={guard} onDirtyChange={setProjectDirty} onDraftTargetChange={setProjectDraftTarget}/></div>
        {view === "guide" && <StepsAndWorkflowsGuide />}
        {view === "activity" && <History items={data.activity} title="Supervision activity" data={data} navigate={navigate} />}
        {settingsOpened && <div hidden={view !== "settings"}><Settings data={data} active={view === "settings"} onDirtyChange={setSettingsDirty}/></div>}
      </main>
      </div>
    </div>
  );
}

function App() {
  useAtomMount(themeAtom);
  const access = useAtomValue(accessAtom);
  const {opened} = useAtomValue(dashboardOpened);
  const {busy, error: signInError} = useAtomValue(signInState);
  const signIn = useAtomSet(signInAction, {mode: "promiseExit"});
  const [token, setToken] = useState("");
  // null until the first access check settles
  const ready = AsyncResult.isSuccess(access) ? access.value.state === "signedIn" : null;
  const error = signInError || (!busy && AsyncResult.isSuccess(access) && access.value.state === "unreachable" ? "Could not reach Supervisor. Try again." : "");
  return <>
    {opened && <div hidden={!ready}><Dashboard onSignedOut={() => setToken("")} /></div>}
    {!ready && <div className="sign-in-layout"><div className="sign-in-intro"><img src="/app-icon.png" width="76" height="76" alt=""/><p className="sign-in-tagline">Keep work<br/>in view.</p><p>Follow the task. Understand the plan. Know when to step in.</p></div><main className="connecting stack">
      <h1>{opened ? "Sign in again" : "Sign in to Supervisor"}</h1>
      {ready === null ? <p role="status">Opening Supervisor…</p> : <form className="stack" onSubmit={async event => {
        event.preventDefault();
        const exit = await signIn(token);
        // the token is single-use: once its session is stored the form forgets it
        if (Exit.isSuccess(exit) && exit.value) setToken("");
      }}>
        {opened && <p>Your open draft is kept in this tab.</p>}
        <p>Stay signed in for 30 days on this browser, until you sign out.</p>
        <p className="muted">Use a one-time token from the machine running Supervisor.</p><details><summary>How to get a sign-in token</summary><div className="stack"><p>Generate a sign-in token on the machine running T3 Supervisor:</p>
        <pre><code>t3-supervisor auth forge</code></pre>
        <p className="muted">Run it in your terminal as the account running Supervisor. For Docker or a VM, run it inside that environment. Tokens expire after five minutes and can be used once.</p></div></details>
        <label htmlFor="access-token">Sign-in token</label>
        <input id="access-token" name="token" type="password" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required maxLength={128} value={token} onChange={event => setToken(event.target.value)} />
        <button className="primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {error && <p role="alert">{error}</p>}
      </form>}
    </main></div>}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Supervisor root missing");
createRoot(root).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
);
