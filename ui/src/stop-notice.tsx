import React from "react";
export type StopAudit = {route: string; callerThreadId: string | null; userMessageId: string | null; stoppedAt: number};
export function StopNotice({audit, title, onEnable, busy = false, enableLabel = "Enable supervision"}: {audit: StopAudit; title: string; onEnable: () => void; busy?: boolean; enableLabel?: string}) {
  return <aside className="notice stack" aria-label={`Supervision stopped for ${title}`}>
    <div className="row between"><strong>Supervision stopped · {title}</strong><button type="button" disabled={busy} onClick={onEnable} aria-label={`${enableLabel} for ${title}`}>{enableLabel}</button></div>
    <p className="small">{audit.route === "ui" ? "Stopped in the dashboard" : "Stopped through an agent tool call"} · <time dateTime={new Date(audit.stoppedAt).toISOString()}>{new Date(audit.stoppedAt).toLocaleString()}</time></p>
    {audit.callerThreadId && <p className="small">Caller: <a href={`t3-thread://v1/${audit.callerThreadId}`}>{audit.callerThreadId}</a></p>}
    {audit.userMessageId && <p className="small">Original human message: <code>{audit.userMessageId}</code></p>}
  </aside>;
}
