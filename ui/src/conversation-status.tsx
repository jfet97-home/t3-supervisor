import React from "react";
import type { ConversationEngagement, ConversationDraft } from "../../src/supervision-conversation-contract.js";

export const conversationLabel = (engagement: ConversationEngagement | undefined, fresh = true): string | null => {
  if (!fresh) return "Supervision state may be out of date";
  if (!engagement) return "Conversation state unavailable";
  if (engagement.availability !== "current") return ({catching_up: "Updating conversation understanding", stale: "Supervision state is out of date",
    uncertain: "Supervision outcome unconfirmed", stopped: "Supervision stopped", unavailable: "Supervision unavailable"})[engagement.availability];
  return engagement.mode === "following" ? "Following the conversation" : null;
};

export function ConversationStatus({engagement, fresh}: {engagement: ConversationEngagement | undefined; fresh: boolean}) {
  const label = conversationLabel(engagement, fresh);
  return label ? <p className="small muted"><span aria-live={engagement?.availability === "catching_up" ? "off" : "polite"} aria-atomic="true">{label}</span></p> : null;
}

export function ConversationUnderstanding({draft}: {draft: ConversationDraft | undefined}) {
  if (!draft || !draft.objective && !draft.constraints.length && !draft.questions.length && !draft.findings.length && !draft.duties.length) return null;
  return <details className="small"><summary>Understanding and draft duties</summary><div className="stack">
    {draft.objective && <p>{draft.objective}</p>}
    {draft.constraints.length > 0 && <div><strong>Constraints</strong><ul>{draft.constraints.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    {draft.questions.length > 0 && <div><strong>Open questions</strong><ul>{draft.questions.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    {draft.findings.length > 0 && <div><strong>Findings to assess</strong><ul>{draft.findings.map((finding, i) => <li key={i}>{finding.text}</li>)}</ul></div>}
    {draft.duties.length > 0 && <div><strong>Draft duties</strong><ul>{draft.duties.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    <p className="muted">This understanding can change. Draft duties are neither an accepted plan nor evidence of execution.</p>
  </div></details>;
}
