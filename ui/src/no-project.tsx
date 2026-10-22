import React, {useEffect, useRef, useState} from "react";
import {Schema} from "effect";
import {NoProjectControl, NoProjectControlResult, SupervisionCandidates, SupervisionStartStatus, type NoProjectModeValue} from "../../src/supervisor-control-contract.js";
import {getCsrfToken, loadAccess, sessionHeaders} from "./access.js";
import {type ControlActivity} from "./supervisor-control.js";

async function readJson(path: string, signal?: AbortSignal, payload?: unknown): Promise<unknown> {
  const response = await fetch(`/api/guidance/${path}`, {credentials: "omit", ...(signal ? {signal} : {}),
    ...(payload !== undefined ? {method: "POST", body: JSON.stringify(payload)} : {}),
    headers: {...sessionHeaders(), ...(payload !== undefined ? {"Content-Type": "application/json", "x-csrf-token": getCsrfToken()} : {})}});
  if (response.status === 401 || response.status === 403) await loadAccess().catch(() => false);
  if (!response.ok) throw new Error("unconfirmed");
  return response.json();
}
export function NoProjectPanel({active, onStateChange}: {active: boolean; onStateChange: (value: ControlActivity) => void}) {
  const [control, setControl] = useState<typeof NoProjectControl.Type | null>(null);
  const [mode, setMode] = useState<NoProjectModeValue>("on_request");
  const [busy, setBusy] = useState(false);const [uncertain, setUncertain] = useState(false);const [message, setMessage] = useState("");
  const dirty = control !== null && mode !== control.mode;
  useEffect(() => onStateChange({busy, uncertain, dirty}), [busy, uncertain, dirty, onStateChange]);
  const reload = async () => {
    setBusy(true);
    try {const next = Schema.decodeUnknownSync(NoProjectControl)(await readJson("no-project-control"));setControl(next);setMode(next.mode);setUncertain(false);setMessage("");}
    catch {setMessage("Mode unavailable. Reload before changing it.");setUncertain(true);} finally {setBusy(false);}
  };
  const loaded = useRef(false);
  useEffect(() => {if (active && !loaded.current) {loaded.current = true;void reload();}}, [active]);
  return <form className="panel stack" onSubmit={event => {event.preventDefault();if (!control || busy || uncertain) return;setBusy(true);
    void readJson("no-project-control", undefined, {expectedGeneration: control.generation, mode}).then(value => {
      const result = Schema.decodeUnknownSync(NoProjectControlResult)(value);setControl(result.control);setMode(result.control.mode);setMessage(result.message);setUncertain(result.status !== "saved");
    }).catch(() => {setUncertain(true);setMessage("The mode change is unconfirmed. Reload its saved status before trying again.");}).finally(() => setBusy(false));
  }}>
    <h2>No Project supervision</h2>
    <p>Choose how chats outside projects receive supervision. The master switch overrides every mode.</p>
    {control && !control.globallyEnabled && <p className="notice">The master switch is off.</p>}
    <fieldset disabled={!control || busy || uncertain}><legend>Activation mode</legend>
      {([ ["off", "Off", "No supervision, including explicit Start requests."], ["on_request", "On request", "Start only the chat you choose. New and replacement chats stay off."], ["automatic", "Automatic", "Follow new requests in every eligible No Project chat."] ] as const).map(([value, label, help]) =>
        <label className="toggle" key={value}><input type="radio" name="noProjectMode" value={value} checked={mode === value} onChange={() => setMode(value)}/><span>{label}<small>{help}</small></span></label>)}
    </fieldset>
    <p className="small muted">On request is the default. Start remains enabled until Stop; a settled Supervisor is only parked. Shared definitions supply policy independently. With shared definitions off, plans use task-local steps.</p>
    <div className="row"><button type="submit" disabled={busy || uncertain || !dirty}>Save No Project mode</button><button type="button" disabled={busy} onClick={() => void reload()}>Reload mode</button>{dirty && <button type="button" disabled={busy} onClick={() => setMode(control!.mode)}>Discard mode draft</button>}</div>
    <p role="status">{message}</p>
  </form>;
}
export type ChatCandidates = typeof SupervisionCandidates.Type;
export function useChatCandidates(query: string, purpose: "start" | "exclude", active = true) {
  const [data, setData] = useState<ChatCandidates | null>(null);const [error, setError] = useState("");const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();setError("");setData(null);
    const timer = setTimeout(() => {void readJson(`supervision-candidates?${new URLSearchParams({query, purpose})}`, abort.signal)
      .then(value => {if (!abort.signal.aborted) setData(Schema.decodeUnknownSync(SupervisionCandidates)(value));})
      .catch(() => {if (!abort.signal.aborted) setError("Chat search unavailable. Reload to try again.");});}, query ? 200 : 0);
    return () => {clearTimeout(timer);abort.abort();};
  }, [query, purpose, active, revision]);
  return {data, error, reload: () => setRevision(value => value + 1)};
}
const startIntentKey = "supervisor-pending-start";
type StartIntent = {threadId: string; operationId: string};
function retainedStart(): StartIntent | null {
  try {const value = JSON.parse(sessionStorage.getItem(startIntentKey) ?? "null") as StartIntent | null;return value && typeof value.threadId === "string" && typeof value.operationId === "string" ? value : null;} catch {return null;}
}
export function StartSupervisionPanel({active, onStateChange, onChanged}: {active: boolean; onStateChange: (value: boolean) => void; onChanged: () => void}) {
  const [query, setQuery] = useState("");const candidates = useChatCandidates(query, "start", active);
  const [intent, setIntent] = useState<StartIntent | null>(retainedStart);const [busy, setBusy] = useState(false);const [message, setMessage] = useState("");
  useEffect(() => onStateChange(busy || intent !== null), [busy, intent, onStateChange]);
  const complete = (value: unknown, original: StartIntent, fromRead: boolean) => {
    const result = Schema.decodeUnknownSync(SupervisionStartStatus)(value);
    if (result.threadId !== original.threadId || result.operationId !== original.operationId) throw new Error("scope_mismatch");
    setMessage(result.reason);
    // absence during a failed POST can race its still-running handler; it never clears the unknown-operation fence
    if (result.status !== "pending" && !(fromRead && result.status === "denied")) {sessionStorage.removeItem(startIntentKey);setIntent(null);candidates.reload();onChanged();}
  };
  const start = (threadId: string) => {
    if (busy || intent) return;
    const next = {threadId, operationId: crypto.randomUUID()};
    sessionStorage.setItem(startIntentKey, JSON.stringify(next));setIntent(next);setBusy(true);setMessage("Saving Start…");
    void readJson("supervision-start", undefined, next).then(value => complete(value, next, false))
      .catch(() => setMessage("Start outcome is unknown. Check the original operation status; no new Start will be sent."))
      .finally(() => setBusy(false));
  };
  return <section hidden={!active} className="panel stack" aria-labelledby="start-supervision-heading">
    <details><summary id="start-supervision-heading">Start supervision for a No Project chat</summary><div className="stack"><p>Choose a recent chat, search by title or ID, or paste its T3 link. Start stays enabled until explicit Stop.</p>
    <label htmlFor="start-chat-search">Find a chat</label><input id="start-chat-search" type="search" value={query} maxLength={512} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-describedby="start-chat-help" onChange={event => setQuery(event.target.value)}/>
    <p id="start-chat-help" className="small muted">{candidates.error || candidates.data?.message || "Loading recent chats…"}</p>
    {candidates.error && <button type="button" onClick={candidates.reload}>Reload chat search</button>}
    <ul className="candidate-list">{candidates.data?.candidates.map(chat => <li key={chat.id} className="row between"><div><strong>{chat.title}</strong><p className="small muted">{chat.id}{chat.active ? " · Started" : chat.excluded ? " · Stopped" : ""}</p></div><button type="button" disabled={busy || intent !== null || chat.active} aria-label={`Start supervision for ${chat.title}`} onClick={() => start(chat.id)}>{chat.active ? "Started" : "Start supervision"}</button></li>)}</ul>
    {intent && <div className="notice stack"><p>Retained Start for <code>{intent.threadId}</code></p><button type="button" disabled={busy} onClick={() => {setBusy(true);void readJson(`supervision-start?${new URLSearchParams(intent)}`).then(value => complete(value, intent, true)).catch(() => setMessage("Start status unavailable. The original operation remains held.")).finally(() => setBusy(false));}}>Check Start status</button></div>}
    <p role="status">{message}</p>
    </div></details>
  </section>;
}
