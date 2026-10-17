import { clearAccess, setSessionToken, sessionHeaders } from "./access.js";
import { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  RegistryProvider,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import type {
  GuidanceActivity,
  GuidanceSnapshot,
} from "../../src/guidance-contract.js";
import {
  loadAccess,
  getCsrfToken,
  threadPolicyAtom,
  snapshotAtom,
} from "./api.js";
import "./style.css";
import { directoryRoute, RouteLink, useNavigation, type Route } from "./navigation.js";
import { ProjectDefinitionsPanel } from "./project-definitions.js";
import { StepsAndWorkflowsGuide } from "./steps-and-workflows-guide.js";
import { idleControlActivity, SupervisionControlPanel, GlobalDefinitionsControlPanel } from "./supervisor-control.js";

const labels: Record<string, string> = {
  observe: "Observe only",
  paused: "Paused",
  send: "Send guidance",
  observe_only: "Observe only",
  no_match: "No match",
  needs_context: "Needs context",
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
  title,
}: {
  items: ReadonlyArray<GuidanceActivity>;
  title: string;
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
          <p className="muted">Recorded activity is retained as evidence.</p>
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
        {items
          .filter((item) =>
            JSON.stringify(item).toLowerCase().includes(filter.toLowerCase()),
          )
          .map((item) => (
            <article key={item.id}>
              <div>
                <div className="row">
                  <strong>{label(item.kind)}</strong>
                  <span className="pill">{label(item.state)}</span>
                </div>
                <p>{label(item.reason)}</p>
                <small className="muted">
                  {new Date(item.createdAt).toLocaleString()} ·{" "}
                  {item.threadId ?? "Supervisor"}
                </small>
              </div>
              <button onClick={() => inspect(item)}>Inspect</button>
            </article>
          ))}
        {items.length === 0 && (
          <p className="muted">No retained activity yet.</p>
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
function ChatSettings({ data, onDirtyChange }: { data: GuidanceSnapshot; onDirtyChange: (dirty: boolean) => void }) {
  const [form, setForm] = useState(data.threadPolicy);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => onDirtyChange(dirty || saving), [dirty, saving, onDirtyChange]);
  const save = useAtomSet(threadPolicyAtom, { mode: "promise" });
  const refresh = useAtomRefresh(snapshotAtom);
  useEffect(() => { if (!dirty) setForm(data.threadPolicy); }, [data.threadPolicy, dirty]);
  const chats = [...data.threads, ...form.excludedThreadIds.filter(id => !data.threads.some(t => t.id === id)).map(id => ({ id, title: "Unavailable chat", available: false }))];
  const change = (patch: Partial<typeof form>) => { setForm({ ...form, ...patch }); setDirty(true); setMessage(""); };
  return <form className="panel stack" method="post" onSubmit={async event => {
    event.preventDefault(); setSaving(true);
    try { const result = await save({ payload: form }); setForm(result); setDirty(false); setMessage("Chat settings saved and applied."); refresh(); }
    catch { setMessage("Chat settings invalid or changed in another tab. Reload first."); }
    finally { setSaving(false); }
  }}>
    <h2>Chat settings</h2>
    <p>Saved for this Supervisor instance. Changes apply without restarting.</p>
    <fieldset><legend>Excluded chats</legend>
      <p>Project Supervisors skip excluded chats. Existing project, workflow and conversation state is retained.</p>
      <label htmlFor="chat-search">Find a chat</label><input id="chat-search" name="chatSearch" type="search" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="chat-options">{chats.filter(t => `${t.title} ${t.id}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => a.title.localeCompare(b.title)).map(t => <label className="toggle" key={t.id}>
        <input type="checkbox" name="excludedThreadIds" value={t.id} checked={form.excludedThreadIds.includes(t.id)} onChange={e => change({ excludedThreadIds: e.target.checked ? [...form.excludedThreadIds, t.id] : form.excludedThreadIds.filter(id => id !== t.id) })} />
        <span>{t.title}<small>{t.id}{!t.available ? " · unavailable" : ""}</small></span>
      </label>)}</div>
      <small>{form.excludedThreadIds.length} chats excluded.</small>
    </fieldset>
    <div className="save-bar">{dirty && <span>Unsaved chat exclusions</span>}<button className="primary" disabled={saving || !dirty} type="submit">{saving ? "Saving…" : "Save chat settings"}</button>{dirty && <button type="button" disabled={saving} onClick={() => {setForm(data.threadPolicy);setDirty(false);setMessage("");}}>Discard draft</button>}</div><p role="status">{message}</p>
  </form>;
}
function Settings({data, onDirtyChange}: {data: GuidanceSnapshot; onDirtyChange: (dirty: boolean) => void}) {
  const [controlRevision, setControlRevision] = useState(0);
  const [chatDirty, setChatDirty] = useState(false);
  const [masterActivity, setMasterActivity] = useState(idleControlActivity);
  const [definitionsActivity, setDefinitionsActivity] = useState(idleControlActivity);
  useEffect(() => onDirtyChange(chatDirty || masterActivity.busy || masterActivity.uncertain || definitionsActivity.busy || definitionsActivity.uncertain), [chatDirty, masterActivity, definitionsActivity, onDirtyChange]);
  return <section className="stack"><div className="page-heading"><p className="kicker">Instance</p><h1>Settings</h1><p className="muted">Shared controls for this Supervisor installation.</p></div><SupervisionControlPanel onStateChange={setMasterActivity} onChanged={() => setControlRevision(value => value + 1)} /><GlobalDefinitionsControlPanel refreshKey={controlRevision} onStateChange={setDefinitionsActivity}/><ChatSettings data={data} onDirtyChange={setChatDirty}/>
    <div className="panel stack"><h2>T3 connection</h2><p>{data.connected ? "Connected" : "Disconnected"} · Build: {data.serverVersion ?? "Unavailable"}</p><p>{data.coverage}</p>
      <details><summary>Advanced connection and editing details</summary><div className="stack"><h3>Project configuration editing</h3><p>Configure a dedicated credential with filesystem:read and filesystem:write at T3_PROJECT_WRITE_TOKEN_FILE through deployment setup. The editor writes only .t3-supervisor/project.yaml in the selected working directory. Step and workflow definitions are read-only in the dashboard.</p>
      <p>Native dialogue can record plan proposals and agreement; those records do not prove step execution.</p></div></details>
    </div></section>;
}
function Dashboard({onSignOut}: {onSignOut: () => Promise<void>}) {
  const [signOutError, setSignOutError] = useState("");
  const snapshot = useAtomValue(snapshotAtom);
  const refresh = useAtomRefresh(snapshotAtom);
  const {route, navigate, guard} = useNavigation();
  const view = route.page;
  useEffect(() => { document.title = `${route.projectId ? "Project" : route.page[0]!.toUpperCase() + route.page.slice(1)} · Supervisor`; document.getElementById("workspace")?.focus({preventScroll: true}); }, [route]);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsOpened, setSettingsOpened] = useState(view === "settings");
  useEffect(() => { if (view === "settings") setSettingsOpened(true); }, [view]);
  const [projectDirty, setProjectDirty] = useState(false);
  const [projectDraftTarget, setProjectDraftTarget] = useState<Route | null>(null);
  const lastData = useRef<GuidanceSnapshot | null>(null);
  const previousConnection = useRef<boolean | null>(null);
  if (snapshot._tag === "Success") lastData.current = snapshot.value;
  const connected = snapshot._tag === "Success" && snapshot.value.connected;
  useEffect(() => {
    if (snapshot._tag === "Failure") void loadAccess().catch(() => false);
  }, [snapshot._tag]);
  useEffect(() => {
    if (previousConnection.current === false && connected) void loadAccess().catch(() => false);
    previousConnection.current = connected;
  }, [connected]);
  useEffect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (projectDirty || settingsDirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [projectDirty, settingsDirty]);
  if (snapshot._tag !== "Success" && !lastData.current)
    return (
      <main className="panel">
        <h1>Supervisor</h1>
        <p>
          {snapshot._tag === "Failure"
            ? "Supervisor connection unavailable."
            : "Connecting…"}
        </p>
        <button onClick={() => { void loadAccess().then(refresh, refresh); }}>
          Retry
        </button>
      </main>
    );
  const data = snapshot._tag === "Success" ? snapshot.value : {...lastData.current!, connected: false};
  const dirty = projectDirty || settingsDirty;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace" onClick={event => {event.preventDefault();document.getElementById("workspace")?.focus();}}>Skip to content</a>
      <header className="app-header">
        <RouteLink to={directoryRoute} navigate={navigate} className="app-name">Supervisor<span className="app-name-detail"> / Work console</span></RouteLink>
        <div className="row"><span className="connection"><span className={`dot ${data.connected ? "online" : ""}`} />{data.connected ? "T3 connected" : "Disconnected"}</span><button disabled={dirty} aria-describedby={dirty ? "pending-changes" : undefined} title={dirty ? "Save drafts and resolve pending changes before signing out." : undefined} onClick={() => { void onSignOut().catch(() => setSignOutError("Could not sign out. Try again.")); }}>Sign out</button></div>
      </header>
      <nav className="app-nav" aria-label="Supervisor sections">
        {(["projects", "activity", "settings", "guide"] as const).map(name => <RouteLink key={name} to={{...directoryRoute, page: name}} navigate={navigate} aria-current={view === name ? "page" : undefined}>{name[0]!.toUpperCase() + name.slice(1)}{name === "settings" && settingsDirty && <span className="draft-dot" aria-label="Unsaved changes" />}</RouteLink>)}
      </nav>
      <main id="workspace" tabIndex={-1}>
        {dirty && <p id="pending-changes" className="notice" role="status">Save drafts and resolve pending changes before signing out. {projectDirty && projectDraftTarget && <RouteLink to={projectDraftTarget} navigate={navigate}>Review project changes</RouteLink>}{projectDirty && settingsDirty && " · "}{settingsDirty && <RouteLink to={{...directoryRoute, page: "settings"}} navigate={navigate}>Review instance settings</RouteLink>}</p>}
        {signOutError && <p className="notice" role="alert">{signOutError}</p>}
        {snapshot._tag === "Failure" && <p className="notice" role="alert">Supervisor connection unavailable. Your drafts are kept.</p>}
        <div hidden={view !== "projects"}><ProjectDefinitionsPanel data={data} route={route} navigate={navigate} guard={guard} csrfToken={getCsrfToken()} onDirtyChange={setProjectDirty} onDraftTargetChange={setProjectDraftTarget}/></div>
        {view === "guide" && <StepsAndWorkflowsGuide />}
        {view === "activity" && <History items={data.activity} title="Supervision activity" />}
        {settingsOpened && <div hidden={view !== "settings"}><Settings data={data} onDirtyChange={setSettingsDirty}/></div>}
      </main>
      <footer>Plans are records. Agreement is not execution.</footer>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [opened, setOpened] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connect = async () => {
    const authenticated = await loadAccess();
    setReady(authenticated);
    if (authenticated) setOpened(true);
    return authenticated;
  };
  useEffect(() => {
    let active = true;
    void loadAccess()
      .then(value => { if (active) { setReady(value); setOpened(value); } })
      .catch(() => { if (active) { setReady(false); setError("Could not reach Supervisor. Try again."); } });
    const expired = () => { setReady(false); };
    window.addEventListener("supervisor-auth-required", expired);
    return () => { active = false; window.removeEventListener("supervisor-auth-required", expired); };
  }, []);
  const signOut = async () => {
    const response = await fetch("/auth/logout", {method: "POST", credentials: "omit", headers: {"Content-Type": "application/json", ...sessionHeaders()}, body: "{}"});
    if (!response.ok) throw new Error("Sign out unavailable.");
    clearAccess(); setOpened(false); setReady(false); setToken(""); setError("");
  };
  return <>
    {opened && <div hidden={!ready}><Dashboard onSignOut={signOut} /></div>}
    {!ready && <main className="connecting panel stack">
      <h1>Supervisor</h1>
      {ready === null ? <p role="status">Opening Supervisor…</p> : <form className="stack" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError("");
        try {
          const response = await fetch("/auth/login", {method: "POST", credentials: "omit", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token})});
          if (!response.ok) { setError(response.status === 401 ? "The sign-in token is invalid, expired or already used." : "Could not sign in. Try again."); return; }
          const payload: unknown = await response.json();
          if (typeof payload !== "object" || payload === null || !("session" in payload) || typeof payload.session !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(payload.session)) throw new Error("Invalid sign-in response.");
          setSessionToken(payload.session);
          setToken("");
          if (!(await connect())) setError("Sign-in could not be confirmed. Try again.");
        } catch { setError("Could not reach Supervisor. Try again."); }
        finally { setBusy(false); }
      }}>
        <h2>{opened ? "Sign in again" : "Sign in"}</h2>
        {opened && <p>Your open draft is kept in this tab.</p>}
        <p className="muted">Use a one-time token from the machine running Supervisor.</p><details><summary>How to get a sign-in token</summary><div className="stack"><p>Generate a sign-in token on the machine running T3 Supervisor:</p>
        <pre><code>t3-supervisor auth forge</code></pre>
        <p className="muted">Run it in your terminal as the account running Supervisor. For Docker or a VM, run it inside that environment. Tokens expire after five minutes and can be used once.</p></div></details>
        <label htmlFor="access-token">Sign-in token</label>
        <input id="access-token" name="token" type="password" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required maxLength={128} value={token} onChange={event => setToken(event.target.value)} />
        <button className="primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {error && <p role="alert">{error}</p>}
      </form>}
    </main>}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Supervisor root missing");
createRoot(root).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
);
