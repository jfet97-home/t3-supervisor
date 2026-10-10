import { canResetActivity,guidanceScopeForSelection,guidanceScopeAfterClassification } from "../../src/guidance-contract.js";
import { useEffect, useState, useRef, type FormEvent,type Dispatch,type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import {
  RegistryProvider,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import type {
  GuidanceActivity,
  GuidanceRule,
  GuidanceRuleInput,
  GuidanceSettings,
  GuidanceSnapshot,
} from "../../src/guidance-contract.js";
import {
  actionAtom,
  classifyAtom,
  draftAtom,
  loadSession,
  login,
  logout,
  muteAtom,
  previewAtom,
  saveRuleAtom,
  settingsAtom,
  snapshotAtom,
} from "./api.js";
import "./style.css";

const labels: Record<string, string> = {
  observe: "Observe only",
  paused: "Paused",
  send: "Send guidance",
  observe_only: "Observe only",
  no_match: "No match",
  needs_context: "Needs context",
  uncertain: "Delivery uncertain",
  cleanup_uncertain: "Cleanup uncertain",
  sent: "Confirmed sent",
  visible: "Visible in chat",
  accepted: "Accepted by T3",
  rejected: "Rejected",
  not_deliverable: "Not deliverable",
  delivered_later_run: "Delivered to a later run",
  model_did_not_qualify_turn: "Luna did not qualify this turn for a recap",
};
const label = (value: string) => labels[value] ?? value.replaceAll("_", " ");
const blank = (scope: string): GuidanceRuleInput => ({
  id: null,
  expectedGeneration: 0,
  name: "",
  condition: "",
  message: "",
  scope:
    scope === "global" ? "global" : scope === "scratch" ? "scratch" : "project",
  projectId: scope === "global" || scope === "scratch" ? null : scope,
  mode: "paused",
});
const inputOf = (rule: GuidanceRule): GuidanceRuleInput => ({
  ...rule,
  expectedGeneration: rule.generation,
});
function Login({ onLogin }: { onLogin: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(code);
      setCode("");
      onLogin();
    } catch {
      setError(
        "Code invalid or expired. Generate a fresh local code and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login panel">
      <p className="eyebrow">LOCAL OWNER ACCESS</p>
      <h1>Your supervisor</h1>
      <p>Manage guidance and see what happened with recaps and Telegram.</p>
      <form onSubmit={submit}>
        <label htmlFor="code">Local login code</label>
        <input
          id="code"
          type="password"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="primary" disabled={busy}>
          {busy ? "Connecting…" : "Open supervisor"}
        </button>
      </form>
      <p role="alert">{error}</p>
      <details>
        <summary>Where do I get the code?</summary>
        <p>
          Run the local <code>ui:login-code</code> command in the supervisor
          container. The code expires after 15 minutes and works once. T3
          credentials stay on the server.
        </p>
      </details>
    </main>
  );
}
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
  const action = useAtomSet(actionAtom, { mode: "promise" });
  const refresh = useAtomRefresh(snapshotAtom);
  const [error, setError] = useState("");
  const inspect = (item: GuidanceActivity) => {
    setSelected(item);
    dialog.current?.showModal();
  };
  const reset = async (accept: boolean) => {
    if (!selected) return;
    if (
      accept &&
      !confirm(
        "The old notice may have arrived or may still arrive. Future guidance could duplicate it. Accept this uncertainty without resending the old notice?",
      )
    )
      return;
    try {
      await action({
        payload: {
          id: selected.id,
          noticeId: selected.noticeId ?? null,
          expectedEpoch: selected.episodeEpoch ?? 0,
          action: accept ? "accept_uncertainty" : "reset",
        },
      });
      refresh();
      dialog.current?.close();
    } catch {
      setError("The action is unavailable or a dispatch is still in flight.");
    }
  };
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
        {selected?.ruleId && (
          <div className="row">
            {canResetActivity(selected) && <button onClick={() => reset(false)}>Reset episode</button>}
            <button
              onClick={async () => {
                if (!selected) return;
                try {
                  await action({
                    payload: { id: selected.id, action: "feedback_wrong",noticeId:selected.noticeId??null,expectedEpoch:selected.episodeEpoch??0 },
                  });
                  refresh();
                  setError("Feedback recorded; the rule was not changed.");
                } catch {
                  setError("Feedback could not be saved.");
                }
              }}
            >
              This was wrong
            </button>
            {selected.state === "uncertain" && selected.noticeId && canResetActivity(selected) && (
              <button onClick={() => reset(true)}>Accept uncertainty</button>
            )}
          </div>
        )}
        <p role="alert">{error}</p>
      </dialog>
    </section>
  );
}
function Rules({
  data,
  scope: requestedScope,
  setScope,
}: {
  data: GuidanceSnapshot;
  scope: string;
  setScope: Dispatch<SetStateAction<string>>;
}) {
  const scope=guidanceScopeForSelection(requestedScope,data.projects);
  const [draft, setDraft] = useAtom(draftAtom);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState("");
  const [result, setResult] = useState("");
  const save = useAtomSet(saveRuleAtom, { mode: "promise" });
  const mute = useAtomSet(muteAtom, { mode: "promise" });
  const preview = useAtomSet(previewAtom, { mode: "promise" });
  const classify = useAtomSet(classifyAtom, { mode: "promise" });
  const refresh = useAtomRefresh(snapshotAtom);
  useEffect(() => {
    if (!draft)
      setDraft({
        input: data.rules[0] ? inputOf(data.rules[0]) : blank(scope),
        dirty: false,
      });
  }, [data.rules, draft, scope, setDraft]);
  if (!draft) return <p>Loading editor…</p>;
  const change = (patch: Partial<GuidanceRuleInput>) => {
    setDraft({ input: { ...draft.input, ...patch }, dirty: true });
    setResult("");
  };
  const select = (input: GuidanceRuleInput) => {
    if (draft.dirty && !confirm("Discard your unsaved rule edits?")) return;
    setDraft({ input, dirty: false });
    setMessage("");
    setResult("");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const rule = await save({ payload: draft.input });
      setDraft({ input: inputOf(rule), dirty: false });
      setMessage(
        rule.mode !== draft.input.mode
          ? "Saved in Observe only because the rule text changed. Enable sends on this revision separately."
          : "Rule saved.",
      );
      refresh();
    } catch {
      setMessage(
        "Save failed. Check the fields or reload the rule if another tab changed it.",
      );
    } finally {
      setBusy(false);
    }
  };
  const visible = data.rules.filter((rule) =>
    scope === "global"
      ? rule.scope === "global"
      : rule.scope === "global" ||
        (scope === "scratch" && rule.scope === "scratch") ||
        (rule.scope === "project" && rule.projectId === scope),
  );
  const project = data.projects.find((p) => p.id === scope);
  const toggleMute = async (rule: GuidanceRule) => {
    try {
      const muted = data.mutes.some(
        (m) => m.ruleId === rule.id && m.scopeId === scope,
      );
      await mute({
        payload: {
          ruleId: rule.id,
          scopeId: scope,
          muted: !muted,
          expectedGeneration: rule.generation,
        },
      });
      refresh();
    } catch {
      setMessage("The global rule changed. Refresh before muting it.");
    }
  };
  const classifyProject = async (classification: "project" | "scratch") => {
    try {
      await classify({
        payload: {
          projectId: scope,
          classification,
          expectedGeneration: data.settings.generation,
        },
      });
      if(classification==="scratch")setScope(current=>guidanceScopeAfterClassification(current,scope));
      refresh();
    } catch {
      setMessage("Project unavailable or settings changed. Refresh first.");
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const value = await preview({
        payload: {
          condition: draft.input.condition,
          message: draft.input.message,
          evidence: sample,
        },
      });
      setResult(`${label(value.verdict)}: ${value.reason}`);
    } catch {
      setResult(
        "Preview unavailable: check the model connection or monitoring budget.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <div className="toolbar">
        <div>
          <label htmlFor="scope">Show rules for</label>
          <select
            id="scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="global">Global rules</option>
            <option value="scratch">No-project chats</option>
            {data.projects.filter((p) => p.classification !== "scratch").map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.available ? "" : " · unavailable"}
              </option>
            ))}
          </select>
          <small className="muted">Projects sync automatically from T3.</small>
        </div>
        <button className="primary" onClick={() => select(blank(scope))}>
          + New rule
        </button>
      </div>
      {project?.classification === "unclassified" && (
        <div className="notice">
          <strong>Scope classification unavailable.</strong>
          <p>
            Rules whose scope or mute differs cannot send until this project is
            classified.
          </p>
          <div className="row">
            <button onClick={() => classifyProject("project")}>
              Treat as project
            </button>
            <button onClick={() => classifyProject("scratch")}>
              Treat as no-project
            </button>
          </div>
        </div>
      )}
      <div className="columns">
        <aside className="rule-list">
          {visible.map((rule) => (
            <article
              className={`rule-card ${draft.input.id === rule.id ? "selected" : ""}`}
              key={rule.id}
            >
              <button
                className="rule-title"
                onClick={() => select(inputOf(rule))}
              >
                {rule.name}
              </button>
              <div className="row">
                <span className="pill">
                  {rule.scope === "global"
                    ? "Global"
                    : rule.scope === "scratch"
                      ? "No-project"
                      : "Project"}
                </span>
                <span className="pill">{label(rule.mode)}</span>
              </div>
              {scope !== "global" && rule.scope === "global" && (
                <button onClick={() => toggleMute(rule)}>
                  {data.mutes.some(
                    (m) => m.ruleId === rule.id && m.scopeId === scope,
                  )
                    ? "Restore here"
                    : "Mute here"}
                </button>
              )}
            </article>
          ))}
          {visible.length === 0 && (
            <p className="muted">Create a rule or select another scope.</p>
          )}
        </aside>
        <div className="panel">
          <div className="row between">
            <h2>{draft.input.name || "New guidance rule"}</h2>
            <span className="pill">
              {draft.input.id
                ? `Revision ${data.rules.find((r) => r.id === draft.input.id)?.revision ?? "saved"}`
                : "Unsaved draft"}
            </span>
          </div>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="name">Rule name</label>
              <input
                id="name"
                required
                maxLength={100}
                value={draft.input.name}
                onChange={(e) => change({ name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="condition">When to notice</label>
              <p className="hint">
                Describe the situation in your own words. Include exceptions.
              </p>
              <textarea
                id="condition"
                required
                maxLength={8000}
                value={draft.input.condition}
                onChange={(e) => change({ condition: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="message">What to tell the chat</label>
              <p className="hint">
                Your exact message; the supervisor adds its notice identity.
              </p>
              <textarea
                id="message"
                required
                maxLength={8000}
                value={draft.input.message}
                onChange={(e) => change({ message: e.target.value })}
              />
            </div>
            <fieldset>
              <legend>Rule mode</legend>
              <div className="mode-options">
                {(["paused", "observe", "send"] as const).map((mode) => (
                  <label key={mode}>
                    <input
                      type="radio"
                      name="mode"
                      checked={draft.input.mode === mode}
                      onChange={() => change({ mode })}
                    />
                    {label(mode)}
                  </label>
                ))}
              </div>
            </fieldset>
            {draft.input.mode === "send" && !data.sendingReady && (
              <p className="notice">{data.sendingReason}</p>
            )}
            <div className="row between actions">
              <span className="muted">
                {draft.dirty ? "Unsaved changes" : "Saved"}
              </span>
              <div className="row">
                <button
                  type="button"
                  onClick={() =>
                    select(
                      draft.input.id &&
                        data.rules.find((r) => r.id === draft.input.id)
                        ? inputOf(
                            data.rules.find((r) => r.id === draft.input.id)!,
                          )
                        : blank(scope),
                    )
                  }
                >
                  Discard edits
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? "Working…" : "Save rule"}
                </button>
              </div>
            </div>
          </form>
          <p role="status">{message}</p>
          <div className="preview">
            <strong>Message preview</strong>
            <pre>{`[Supervisor guidance · ${draft.input.name || "Rule name"} · notice PREVIEW]\n\n${draft.input.message}`}</pre>
          </div>
          <div className="test-box">
            <h3>Test without sending</h3>
            <label htmlFor="sample">Example evidence</label>
            <textarea
              id="sample"
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              placeholder="Actor: current intention, relevant context and later corrections…"
            />
            <button
              disabled={busy || !sample.trim() || !draft.input.condition.trim()}
              onClick={test}
            >
              Evaluate example
            </button>
            <p role="status">{result}</p>
            <p className="hint">
              Uses the configured detector and monitoring budget. Sends nothing
              to T3 or Telegram.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
function Settings({ data }: { data: GuidanceSnapshot }) {
  const [form, setForm] = useState<GuidanceSettings>(data.settings);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const save = useAtomSet(settingsAtom, { mode: "promise" });
  const refresh = useAtomRefresh(snapshotAtom);
  useEffect(() => {
    if (!dirty) setForm(data.settings);
  }, [data.settings, dirty]);
  const change = (patch: Partial<GuidanceSettings>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await save({
        payload: {
          ...form,
        },
      });
      setDirty(false);
      setMessage("Settings saved.");
      refresh();
    } catch {
      setMessage("Settings changed or invalid. Reload first.");
    }
  };
  return (
    <section>
      <h2>One monitor, one place to manage it</h2>
      <div className="detail-grid">
        <div className="panel stack">
          <h3>T3 connection</h3>
          <span className="pill">
            {data.connected ? "Read connection active" : "Disconnected"}
          </span>
          <p>{data.sendingReason}</p>
          <p className="muted">Build: {data.serverVersion ?? "Unavailable"}</p>
          <h3>Coverage</h3>
          <p>{data.coverage}</p>
          <small>
            Last cycle:{" "}
            {data.lastCycleAt
              ? new Date(data.lastCycleAt).toLocaleString()
              : "Not yet"}
          </small>
          <p>
            Budget reserved today: {data.tokensUsed.toLocaleString()} /{" "}
            {data.settings.dailyTokenBudget.toLocaleString()}
          </p>
          <details>
            <summary>Guidance write access</summary>
            <p>
              Mount a dedicated T3 operate credential as{" "}
              <code>t3-guidance-token</code> and restart the supervisor.
              Questionnaire credentials stay separate. Guidance is advisory:
              delivery can arrive after the action.
            </p>
          </details>
        </div>
        <form className="panel" onSubmit={submit}>
          <h3>Monitoring settings</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.guidancePaused}
              onChange={(e) => change({ guidancePaused: e.target.checked })}
            />
            <span>
              Pause guidance
              <small>Recaps, questions and observation continue.</small>
            </span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.monitoringPaused}
              onChange={(e) => change({ monitoringPaused: e.target.checked })}
            />
            <span>
              Pause monitoring
              <small>Stop evaluations and their model cost.</small>
            </span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.allowFollowupRace}
              onChange={(e) => change({ allowFollowupRace: e.target.checked,verifiedServerVersion:e.target.checked?data.serverVersion:null })}
            />
            <span>
              Allow the documented delivery race
              <small>
                T3 may start a follow-up turn if the active turn finishes during
                delivery. Re-enable after a T3 build change.
              </small>
            </span>
          </label>
          <div className="field">
            <label htmlFor="model">Detector model</label>
            <input id="model" readOnly value={form.model} />
          </div>
          <div className="field">
            <label htmlFor="reasoning">Reasoning</label>
            <select
              id="reasoning"
              value={form.reasoning}
              onChange={(e) =>
                change({
                  reasoning: e.target.value as GuidanceSettings["reasoning"],
                })
              }
            >
              {["low", "medium", "high", "xhigh", "max"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="budget">Daily reserved token budget</label>
            <input
              id="budget"
              type="number"
              min={1000}
              max={1000000}
              step={1000}
              value={form.dailyTokenBudget}
              onChange={(e) =>
                change({ dailyTokenBudget: Number(e.target.value) })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="retention">Evidence retention</label>
            <select
              id="retention"
              value={form.evidenceHours}
              onChange={(e) =>
                change({ evidenceHours: Number(e.target.value) })
              }
            >
              <option value={24}>24 hours</option>
              <option value={168}>7 days</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="age">Maximum evidence age (seconds)</label>
            <input
              id="age"
              type="number"
              min={10}
              max={600}
              value={form.maxAnchorAgeSeconds}
              onChange={(e) =>
                change({ maxAnchorAgeSeconds: Number(e.target.value) })
              }
            />
          </div>
          <button className="primary actions">Save settings</button>
          <p role="status">{message}</p>
        </form>
      </div>
    </section>
  );
}
function Dashboard({ onLogout }: { onLogout: () => void }) {
  const snapshot = useAtomValue(snapshotAtom);
  const refresh = useAtomRefresh(snapshotAtom);
  const [view, setView] = useState("rules");
  const [scope, setScope] = useState("global");
  const [draft] = useAtom(draftAtom);
  const saveSettings = useAtomSet(settingsAtom, { mode: "promise" });
  const [pauseError, setPauseError] = useState("");
  useEffect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (draft?.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draft?.dirty]);
  if (snapshot._tag !== "Success")
    return (
      <main className="panel">
        <h1>Supervisor</h1>
        <p>
          {snapshot._tag === "Failure"
            ? "Connection or owner session unavailable."
            : "Connecting…"}
        </p>
        <button onClick={refresh}>Retry</button>
        <button onClick={onLogout}>Owner login</button>
      </main>
    );
  const data = snapshot.value;
  const navigate = (next: string) => {
    if (
      next !== view &&
      draft?.dirty &&
      !confirm("Leave the editor? Your draft will be kept.")
    )
      return;
    setView(next);
  };
  return (
    <main>
      <header className="head row between">
        <div className="row">
          <span className="brand">S</span>
          <div>
            <h1>Supervisor</h1>
            <p className="muted">
              Your instructions, carried through the work.
            </p>
          </div>
        </div>
        <div className="row">
          <button
            onClick={async () => {
              try {
                await saveSettings({
                  payload: {
                    ...data.settings,
                    guidancePaused: !data.settings.guidancePaused,
                  },
                });
                refresh();
                setPauseError("");
              } catch {
                setPauseError(
                  "Pause failed because settings changed. Refresh and try again.",
                );
              }
            }}
          >
            {data.settings.guidancePaused
              ? "Resume guidance"
              : "Pause guidance"}
          </button>
          <button
            onClick={async () => {
              await logout();
              onLogout();
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <p role="alert">{pauseError}</p>
      <div className="connection">
        <span className={`dot ${data.connected ? "online" : ""}`} />
        {data.connected ? "T3 connected" : "Connection gap"} ·{" "}
        {data.projects.filter((p) => p.available).length} projects ·{" "}
        {data.rules.length} rules
      </div>
      <nav aria-label="Supervisor sections">
        {["rules", "activity", "telegram", "settings"].map((name) => (
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
      {view === "rules" && (
        <Rules data={data} scope={scope} setScope={setScope} />
      )}{" "}
      {view === "activity" && (
        <History items={data.activity} title="Guidance activity" />
      )}
      {view === "telegram" && (
        <History items={data.history} title="Recaps & Telegram" />
      )}
      {view === "settings" && <Settings data={data} />}
      <footer>
        Guidance is advisory. Acceptance is not proof of compliance. New
        projects and chats sync automatically.
      </footer>
    </main>
  );
}
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    void loadSession()
      .then(setAuthenticated)
      .catch(() => setAuthenticated(false));
  }, []);
  return authenticated === null ? (
    <p>Opening supervisor…</p>
  ) : authenticated ? (
    <Dashboard onLogout={() => setAuthenticated(false)} />
  ) : (
    <Login onLogin={() => setAuthenticated(true)} />
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Supervisor root missing");
createRoot(root).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
);
