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
import { ProjectDefinitionsPanel } from "./project-definitions.js";

const labels: Record<string, string> = {
  observe: "Observe only",
  paused: "Paused",
  send: "Send guidance",
  observe_only: "Observe only",
  no_match: "No match",
  needs_context: "Needs context",
  uncertain: "Delivery uncertain",
  cleanup_uncertain: "Cleanup uncertain",
  cleanup_expired: "Cleanup expired (not confirmed)",
  deletion_unconfirmed_expired: "Deletion unconfirmed; 24-hour cleanup TTL expired",
  sent: "Confirmed sent",
  visible: "Visible in chat",
  accepted: "Accepted by T3",
  rejected: "Rejected",
  not_deliverable: "Not deliverable",
  delivered_later_run: "Delivered to a later run",
  model_did_not_qualify_turn: "Luna did not qualify this turn for a recap",
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
          <h2>{title}</h2>
          <p className="muted">
            Decisions, delivery and cleanup are separate facts.
          </p>
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
          <p className="muted">
            No retained activity yet. Older skipped recap reasons are
            unavailable.
          </p>
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
function ChatSettings({ data }: { data: GuidanceSnapshot }) {
  const [form, setForm] = useState(data.threadPolicy);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const save = useAtomSet(threadPolicyAtom, { mode: "promise" });
  const refresh = useAtomRefresh(snapshotAtom);
  useEffect(() => { if (!dirty) setForm(data.threadPolicy); }, [data.threadPolicy, dirty]);
  const chats = [...data.threads, ...form.excludedThreadIds.filter(id => !data.threads.some(t => t.id === id)).map(id => ({ id, title: "Unavailable chat", available: false }))];
  if (form.interactiveThreadId && !chats.some(t => t.id === form.interactiveThreadId)) chats.push({ id: form.interactiveThreadId, title: "Unavailable chat", available: false });
  const change = (patch: Partial<typeof form>) => { setForm({ ...form, ...patch }); setDirty(true); setMessage(""); };
  return <form className="panel stack" method="post" onSubmit={async event => {
    event.preventDefault(); setSaving(true);
    try { const result = await save({ payload: form }); setForm(result); setDirty(false); setMessage("Chat settings saved and applied."); refresh(); }
    catch { setMessage("Chat settings invalid or changed in another tab. Reload first."); }
    finally { setSaving(false); }
  }}>
    <h3>Chat settings</h3>
    <p>Saved for this Supervisor instance. Changes apply without restarting.</p>
    <div className="field"><label htmlFor="interactive-chat">Interactive Telegram chat</label>
      <select id="interactive-chat" name="interactiveThreadId" value={form.interactiveThreadId ?? ""} onChange={e => change({ interactiveThreadId: e.target.value || null })}>
        <option value="">None</option>
        {chats.map(t => <option key={t.id} value={t.id} disabled={!t.available && t.id !== form.interactiveThreadId}>{t.title} — {t.id}</option>)}
      </select>
      <small>The selected chat can answer questionnaires through Telegram even when excluded below. Other eligible chats receive plain input-needed notices.</small>
    </div>
    <fieldset><legend>Excluded chats</legend>
      <p>Suppress new completion recaps, forwarded answers, guidance and input-needed notices. Existing delivery records are preserved.</p>
      <label htmlFor="chat-search">Find a chat</label><input id="chat-search" name="chatSearch" type="search" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="chat-options">{chats.filter(t => `${t.title} ${t.id}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => a.title.localeCompare(b.title)).map(t => <label className="toggle" key={t.id}>
        <input type="checkbox" name="excludedThreadIds" value={t.id} checked={form.excludedThreadIds.includes(t.id)} onChange={e => change({ excludedThreadIds: e.target.checked ? [...form.excludedThreadIds, t.id] : form.excludedThreadIds.filter(id => id !== t.id) })} />
        <span>{t.title}<small>{t.id}{!t.available ? " · unavailable" : ""}</small></span>
      </label>)}</div>
      <small>{form.excludedThreadIds.length} chats excluded.</small>
    </fieldset>
    <button className="primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save chat settings"}</button><p role="status">{message}</p>
  </form>;
}
function Settings({data}: {data: GuidanceSnapshot}) {
  return <section className="stack"><h2>Supervisor settings</h2><ChatSettings data={data}/>
    <div className="panel stack"><h3>T3 connection</h3><p>{data.connected ? "Connected" : "Disconnected"} · Build: {data.serverVersion ?? "Unavailable"}</p><p>{data.coverage}</p>
      <h3>Project file editing</h3><p>Configure a dedicated credential with filesystem:read and filesystem:write at T3_PROJECT_WRITE_TOKEN_FILE through deployment setup. The editor writes only .supervisor/rules.yaml in the selected working directory.</p>
      <p>Legacy reminders are retired. Their history is retained; uncertain deliveries are not retried or resolved automatically. Workflow drafts use project rules and existing blocks; agent dialogue and execution monitoring remain pending.</p>
    </div></section>;
}
function Dashboard() {
  const snapshot = useAtomValue(snapshotAtom);
  const refresh = useAtomRefresh(snapshotAtom);
  const [view, setView] = useState("projects");
  const [projectDirty, setProjectDirty] = useState(false);
  const lastData = useRef<GuidanceSnapshot | null>(null);
  const previousConnection = useRef<boolean | null>(null);
  if (snapshot._tag === "Success") lastData.current = snapshot.value;
  const connected = snapshot._tag === "Success" && snapshot.value.connected;
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
      if (projectDirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [projectDirty]);
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
  const navigate = (next: string) => setView(next);
  return (
    <main>
      <header className="head row between">
        <div className="row"><span className="brand">S</span><div><h1>Supervisor</h1><p className="muted">Project rules and reusable workflow blocks.</p></div></div>
      </header>
      {snapshot._tag === "Failure" && <p role="alert">Supervisor connection unavailable. Your project-rule draft is kept.</p>}
      <div className="connection">
        <span className={`dot ${data.connected ? "online" : ""}`} />
        {data.connected ? "T3 connected" : "Connection gap"} ·{" "}
        {data.projects.filter((p) => p.available).length} projects
      </div>
      <nav aria-label="Supervisor sections">
        {["projects", "activity", "telegram", "settings"].map((name) => (
          <button
            key={name}
            aria-current={view === name ? "page" : undefined}
            onClick={() => navigate(name)}
          >
            {name === "telegram"
              ? "Recaps & Telegram"
              : name[0]!.toUpperCase() + name.slice(1)}
          </button>
        ))}
      </nav>
      <div hidden={view !== "projects"}><ProjectDefinitionsPanel data={data} csrfToken={getCsrfToken()} onDirtyChange={setProjectDirty}/></div>
      {view === "activity" && (
        <History items={data.activity} title="Supervision activity" />
      )}
      {view === "telegram" && (
        <History items={data.history} title="Recaps & Telegram" />
      )}
      {view === "settings" && <Settings data={data} />}
      <footer>
        Project files define the rules and workflow blocks. Agent dialogue is not connected yet.
        Projects and chats sync automatically.
      </footer>
    </main>
  );
}
function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const connect = () => {
    setReady(null);
    void loadAccess()
      .then(setReady)
      .catch(() => setReady(false));
  };
  useEffect(() => {
    let active = true;
    void loadAccess()
      .then(value => { if (active) setReady(value); })
      .catch(() => { if (active) setReady(false); });
    return () => { active = false; };
  }, []);
  if (ready) return <Dashboard />;
  return (
    <main className="connecting panel">
      <h1>Supervisor</h1>
      <p role={ready === false ? "alert" : "status"}>
        {ready === null ? "Opening supervisor…" : "Could not connect to the local supervisor."}
      </p>
      {ready === false && <button onClick={connect}>Retry</button>}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Supervisor root missing");
createRoot(root).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
);
