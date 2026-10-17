import React, { useEffect, useState } from "react";
import { Schema } from "effect";
import { SupervisionControl, SupervisionControlResult, SupervisionSetupOptions, SupervisionSetupResult, GlobalDefinitionsControl, GlobalDefinitionsControlResult,
  type SupervisionControlInfo, type GlobalDefinitionsControlInfo, type SupervisionSetupInput } from "../../src/supervisor-control-contract.js";
import { getCsrfToken, loadAccess, sessionHeaders } from "./access.js";

export function SupervisionControlView({control, busy, blocked, message, onToggle, onReload}: {
  control: SupervisionControlInfo;
  busy: boolean;
  blocked: boolean;
  message: string;
  onToggle: () => void;
  onReload: () => void;
}) {
  const global = control.projectId === null;
  return <section className="panel stack" aria-label={global ? "Global supervision" : "Project supervision"}>
    <h3>{global ? "Global supervision" : "Project supervision"}</h3>
    <p><strong>{control.enabled ? "Enabled" : "Disabled"}</strong>{!global && control.enabled && !control.globallyEnabled ? " — global supervision is off" : ""}</p>
    <p>{global ? "The master switch controls semantic supervision across every project and starts enabled." : "This project is supervised only when both its switch and the master switch are enabled. An existing .t3-supervisor folder enables a project initially; your manual choice is remembered."}</p>
    {!global && <p>Folder detection: {control.detectionStatus}. {control.detectionError}</p>}
    <p>Disabling stops new supervisory work. An already-running model turn may finish. Chats, settings and recorded history are retained.</p>
    <div className="row">
      <button type="button" disabled={busy || blocked} onClick={onToggle}>{busy ? "Saving…" : control.enabled ? "Disable supervision" : "Enable supervision"}</button>
      <button type="button" disabled={busy} onClick={onReload}>Reload status</button>
    </div>
    <p role="status">{message}</p>
  </section>;
}

export function SupervisionControlPanel({projectId = null, onChanged}: {projectId?: string | null; onChanged?: () => void}) {
  const [control, setControl] = useState<SupervisionControlInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [setupRequested, setSetupRequested] = useState(false);
  useEffect(() => {
    const abort = new AbortController();setControl(null);
    const query = projectId === null ? "" : `?${new URLSearchParams({projectId})}`;
    void fetch(`/api/guidance/supervision-control${query}`, {credentials: "omit", headers: sessionHeaders(), signal: abort.signal})
      .then(async response => {
        if (!response.ok) throw new Error("unavailable");
        const next = Schema.decodeUnknownSync(SupervisionControl)(await response.json());
        if (next.projectId !== projectId) throw new Error("scope_mismatch");
        if (!abort.signal.aborted) {setControl(next);setBlocked(false);setMessage("");}
      }).catch(() => {if (!abort.signal.aborted) {setBlocked(true);setMessage("Supervision status unavailable. Reload before changing it.");}});
    return () => abort.abort();
  }, [projectId, revision]);
  if (!control) return <section className="panel"><p role="status">{message || "Loading supervision status…"}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Reload status</button></section>;
  return <div className="stack"><SupervisionControlView control={control} busy={busy} blocked={blocked} message={message}
    onReload={() => setRevision(value => value + 1)} onToggle={() => {
      if (busy || blocked) return;
      setBusy(true);setMessage("");
      void fetch("/api/guidance/supervision-control", {method: "POST", credentials: "omit",
        headers: {"Content-Type": "application/json", ...sessionHeaders(), "x-csrf-token": getCsrfToken()},
        body: JSON.stringify({projectId, expectedGeneration: control.generation, enabled: !control.enabled})})
        .then(async response => {
          if (response.status === 401 || response.status === 403) {await loadAccess().catch(() => false);throw new Error("session");}
          if (!response.ok) throw new Error("unknown");
          const result = Schema.decodeUnknownSync(SupervisionControlResult)(await response.json());
          if (result.control.projectId !== projectId) throw new Error("scope_mismatch");
          setControl(result.control);setMessage(result.message);setBlocked(result.status !== "saved" && result.status !== "setup_required");
          setSetupRequested(result.status === "setup_required");
          if (result.status === "saved") onChanged?.();
        }).catch(() => {setBlocked(true);setMessage("The change could not be confirmed. Reload status before trying again.");})
        .finally(() => setBusy(false));
    }} />
    {setupRequested && projectId && <SupervisionSetupPanel projectId={projectId} onComplete={(next, text) => {
      setControl(next);setMessage(text);setSetupRequested(false);setBlocked(false);
    }} />}</div>;
}

type SetupOptions = typeof SupervisionSetupOptions.Type;
type SetupCheckout = SetupOptions["checkouts"][number];
const checkoutKey = (checkout: SetupCheckout) => JSON.stringify([checkout.threadId, checkout.workspaceRoot]);
const checkoutBranch = (checkout: SetupCheckout) => checkout.branch ?? (checkout.isGitRepository ? "Detached HEAD" : "No Git repository");

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
    {checkout && <div><p>Folder: <code>{checkout.workspaceRoot}/.t3-supervisor</code></p><p>Branch: <strong>{checkoutBranch(checkout)}</strong></p><p>Existing setup: {checkout.folderStatus}.</p></div>}
    {checkout?.folderStatus === "present" ? <div>
      <p>Enable the existing definitions at <code>{checkout.workspaceRoot}/.t3-supervisor</code> on branch <strong>{checkoutBranch(checkout)}</strong>. This enables supervision using those files; no files will be written or committed.</p>
      <button type="button" disabled={!canEnableExisting} onClick={() => onSetup("enable_existing")}>Enable existing definitions</button>
    </div> : <p>Create leaves files uncommitted. Create + commit submits the two setup paths from a clean checkout through T3. Repository hooks and signing apply; hooks can alter committed contents, and failure can leave files staged. Neither action switches branches.</p>}
    <div className="row">
      <button type="button" disabled={!canCreate} onClick={() => onSetup("create")}>Create</button>
      <button type="button" disabled={!canCreate || !checkout?.isGitRepository} onClick={() => onSetup("create_and_commit")}>Create + commit</button>
      <button type="button" disabled={busy} onClick={onReload}>Reload setup</button>
    </div><p role="status">{message}</p>
  </section>;
}

function SupervisionSetupPanel({projectId, onComplete}: {projectId: string; onComplete: (control: SupervisionControlInfo, message: string) => void}) {
  const [options, setOptions] = useState<SetupOptions | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();setOptions(null);
    void fetch(`/api/guidance/supervision-setup?${new URLSearchParams({projectId})}`, {credentials: "omit", headers: sessionHeaders(), signal: abort.signal})
      .then(async response => {
        if (!response.ok) throw new Error("unavailable");
        const next = Schema.decodeUnknownSync(SupervisionSetupOptions)(await response.json());
        if (next.projectId !== projectId) throw new Error("scope_mismatch");
        if (!abort.signal.aborted) {setOptions(next);setSelected("");setBlocked(false);setMessage("");}
      }).catch(() => {if (!abort.signal.aborted) {setBlocked(true);setMessage("Setup targets unavailable. Reload before creating files.");}});
    return () => abort.abort();
  }, [projectId, revision]);
  if (!options) return <section className="panel"><p role="status">{message || "Loading checkout choices…"}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Reload setup</button></section>;
  const setup = (action: SupervisionSetupInput["action"]) => {
    const checkout = options.checkouts.find(value => checkoutKey(value) === selected);
    const expectedFolderStatus = action === "enable_existing" ? "present" : "missing";
    if (!checkout || busy || blocked || !options.available || checkout.folderStatus !== expectedFolderStatus) return;
    setBusy(true);setMessage("");
    void fetch("/api/guidance/supervision-setup", {method: "POST", credentials: "omit",
      headers: {"Content-Type": "application/json", ...sessionHeaders(), "x-csrf-token": getCsrfToken()},
      body: JSON.stringify(buildSupervisionSetupIntent(projectId, options.generation, checkout, action))})
      .then(async response => {
        if (response.status === 401 || response.status === 403) {await loadAccess().catch(() => false);throw new Error("session");}
        if (!response.ok) throw new Error("unknown");
        const result = Schema.decodeUnknownSync(SupervisionSetupResult)(await response.json());
        if (result.control.projectId !== projectId || result.workspaceRoot !== checkout.workspaceRoot || result.branch !== checkout.branch) throw new Error("scope_mismatch");
        if (result.status === "saved") onComplete(result.control, result.message);
        else {setBlocked(true);setMessage(result.message);}
      }).catch(() => {setBlocked(true);setMessage("The setup outcome could not be confirmed. Reload and inspect the selected checkout before trying again.");})
      .finally(() => setBusy(false));
  };
  return <SupervisionSetupView options={options} selected={selected} busy={busy} blocked={blocked} message={message}
    onSelect={setSelected} onSetup={setup} onReload={() => setRevision(value => value + 1)} />;
}

export function GlobalDefinitionsControlView({control, busy, blocked, message, onToggle, onReload}: {
  control: GlobalDefinitionsControlInfo; busy: boolean; blocked: boolean; message: string; onToggle: () => void; onReload: () => void;
}) {
  return <section className="panel stack" aria-label="Use global steps and workflows">
    <h3>Use global steps and workflows</h3>
    <p><strong>{control.enabled ? "Enabled" : "Disabled"}</strong>{control.enabled && !control.effectiveEnabled ? " — the master supervision switch is off" : ""}</p>
    <p>Shared definitions: <code>~/.t3-supervisor/project.yaml</code>, <code>steps/</code>, and <code>workflows/</code> in the T3 server user's home.</p>
    <p>This starts disabled. First enabling creates the shared project.yaml and empty steps/ and workflows/ directories if needed. Existing definitions are preserved, and the files are left uncommitted.</p>
    <p>These definitions are shared by enabled project Supervisors and Scratch. Disabling them leaves each enabled project's own definitions available. The master switch overrides all supervision.</p>
    <p>Folder detection: {control.detectionStatus}. {control.detectionError}</p>
    <div className="row">
      <button type="button" disabled={busy || blocked} onClick={onToggle}>{busy ? "Saving…" : control.enabled ? "Disable global definitions" : "Enable global definitions"}</button>
      <button type="button" disabled={busy} onClick={onReload}>Reload global definitions status</button>
    </div><p role="status">{message}</p>
  </section>;
}

export function GlobalDefinitionsControlPanel({refreshKey = 0}: {refreshKey?: number}) {
  const [control, setControl] = useState<GlobalDefinitionsControlInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();setControl(null);
    void fetch("/api/guidance/global-definitions-control", {credentials: "omit", headers: sessionHeaders(), signal: abort.signal})
      .then(async response => {
        if (!response.ok) throw new Error("unavailable");
        const next = Schema.decodeUnknownSync(GlobalDefinitionsControl)(await response.json());
        if (!abort.signal.aborted) {setControl(next);setBlocked(false);setMessage("");}
      }).catch(() => {if (!abort.signal.aborted) {setBlocked(true);setMessage("Global definitions status unavailable. Reload before changing it.");}});
    return () => abort.abort();
  }, [revision, refreshKey]);
  if (!control) return <section className="panel"><p role="status">{message || "Loading global definitions status…"}</p><button type="button" onClick={() => setRevision(value => value + 1)}>Reload status</button></section>;
  return <GlobalDefinitionsControlView control={control} busy={busy} blocked={blocked} message={message} onReload={() => setRevision(value => value + 1)}
    onToggle={() => {
      if (busy || blocked) return;
      setBusy(true);setMessage("");
      void fetch("/api/guidance/global-definitions-control", {method: "POST", credentials: "omit",
        headers: {"Content-Type": "application/json", ...sessionHeaders(), "x-csrf-token": getCsrfToken()}, body: JSON.stringify({expectedGeneration: control.generation, enabled: !control.enabled})})
        .then(async response => {
          if (response.status === 401 || response.status === 403) {await loadAccess().catch(() => false);throw new Error("session");}
          if (!response.ok) throw new Error("unknown");
          const result = Schema.decodeUnknownSync(GlobalDefinitionsControlResult)(await response.json());
          setControl(result.control);setMessage(result.message);setBlocked(result.status !== "saved");
        }).catch(() => {setBlocked(true);setMessage("The global definitions change could not be confirmed. Reload status before trying again.");})
        .finally(() => setBusy(false));
    }} />;
}
