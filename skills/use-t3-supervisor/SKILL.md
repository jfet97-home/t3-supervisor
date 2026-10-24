---
name: use-t3-supervisor
description: Use an existing T3 Supervisor dashboard to inspect project definitions, workflow plans, agreements, progress and teams, edit project configuration or adjust supervision controls and exclusions. For product usage, not source maintenance, deployment or credential provisioning.
---

# Use T3 Supervisor

Supervisor observes native project conversations and their descendants, discusses
workflow plans and records progress. Telegram communication is a separate service.
For detailed controls and edge cases, read [dashboard workflows](references/dashboard.md)
when using that part of the product.

## Connect and sign in

Use the supplied instance URL; the default is http://127.0.0.1:9008. Localhost refers
to the browser's machine. Enter an operator-provided one-use token privately on the
page. The displayed `t3-supervisor auth forge` command runs in the actual service
environment with matching state. Ordinary dashboard usage does not provision
credentials, expose ports or change deployment.

Five-minute grants produce a 30-day origin-scoped browser session. Restart preserves
its original expiry; Sign out revokes it. Expiry retains drafts and sign-in never
replays a rejected mutation. Inspect uncertain outcomes before another write.

## Projects and definitions

To create or refine a step/workflow catalog from a project's instructions, history
and human corrections, use [author-supervisor-workflows](../author-supervisor-workflows/SKILL.md).
Authoring a catalog does not itself enable supervision or adopt its policy.

Steps, workflows and inline local steps may carry optional string lists:
checkout-relative file paths in `references` and local SKILL.md paths or exact
global catalog names in a separate `skills` string list. Definitions
and Task show separate lists read-only; edit source YAML/frontmatter and refresh. The
Guide explains lookup and unavailable guidance. References are not opened or verified
automatically and never enable supervision.

Start on Home for current attention, supervised work and freshness, then open the exact conversation. Projects has Conversations, Definitions and Project settings; a conversation has Task and Supervision. Choose the definitions checkout explicitly, including project root. Project-level views retain that checkout and its draft. Context is remembered per project in the current tab; hash links take precedence. An unavailable conversation never falls back to another checkout. Drafts survive switching views, including instance Settings exclusions.

Projects reads the selected operative checkout's `.t3-supervisor/project.yaml`
index, then the listed full step and workflow files that apply. A summary says
what to read and is not the policy. The index is not a whitelist of task plans;
negotiated local steps remain available. Check source path, workspace, freshness,
diagnostics and completeness. An unlisted file (`definition_unlisted`) is not
read. A missing indexed file (`catalog_entry_missing`) keeps its row and required
flag. Either issue makes the collection invalid and never means no requirements.
Guide explains the format without requiring a configured project. Global
definitions, when enabled, are separately marked and read-only in the project
editor.

Steps have id/name/description. Workflows compose sequence/parallel groups, step
references/local steps and named workflow references. Instructions, applicability
and delegation belong in description. Required references apply to the current main
task; fixed protects original nested commitments and relationships while permitting
support work. Repeated references have distinct occurrences.

Edit only the requested project configuration and confirm the working-tree target.
Save writes the local index only: `workflows`, `steps` (each entry `path`,
`summary`, optional `required`) and the optional `default_workflow`. It does not accept a
separate required list. It leaves files uncommitted and does not edit step or
workflow files. A new project file is `workflows: []` and then `steps: []`. An
invalid row stays visible and the unsaved draft is kept. Refresh/reconcile conflicting or uncertain writes; Discard removes
an unsaved draft. A definite authentication rejection requires a new explicit Save.

First setup selects the exact checkout/branch. Create leaves files uncommitted;
Create + commit requires a safe clean target and already provisioned access, honoring
hooks/signing. Enable existing definitions writes nothing. Neither action switches
branches. Missing native permissions require operator setup, not credential work
hidden inside a dashboard task.

## Controls, plans and progress

The global supervision master switch overrides remembered project choices. Global
definitions are separately opt-in in the T3 server user's home; scratch needs that
input. Model/reasoning choices are defaults for new roots; edit existing chats in T3.
Without saved preferences, new roots use Sol 6.1 with low reasoning. Existing roots
and saved selections keep their models; a model change does not establish a valid plan.
Settings chat exclusions are per-instance, persistent and independent of Telegram.

The default-off agent-created option excludes the chat origin, including later human
follow-ups. When enabled, genuine humans and the exact launching agent can request
work in an eligible ordinary main; agent provenance remains explicit.

Select the actual main to inspect its binding, objective, proposal, agreement,
current workflow and native descendants. Plans preserve nested structure, stable
occurrence IDs and provenance. Child contributions may overlap; child completion
does not complete a parent step automatically. Required inclusion can be recursive.
Matching complete native proposal/acceptance records establish agreement, not actual
execution. Keep incomplete requirements and source issues visible.

“Following the conversation” means the enabled Supervisor has considered the current
dialogue and is keeping a quiet understanding and draft duties. Discussion can include
permitted exploration. A requested research report can itself authorize a workflow;
implementation and deployment require their actual requested scope. A direct action
request needs no extra confirmation. Pause/discuss keeps the same task and retained
agreement; explicit Stop Supervisor disables supervision. Neutral questions retain
existing authorization. Catching up, stale and unavailable labels do not claim fresh
following.

On an authorized outcome, negotiate the applicable workflow promptly. Inspect both conversations and Task for the
actual proposal and acceptance; a ready binding alone does not establish agreement.
Guidance is asynchronous and T3 provides no pre-first-tool barrier. Trivial exchanges
should stay quiet. Report repeated introductions, redundant steering or large repeated
messages as defects rather than accepting them as necessary supervision.

All prior work can count when the Supervisor has adequate actual evidence, including
implementation, verification, review and documentation. Initial duties start planned,
then receive a separate evidence-backed assessment. Partial work states the remaining
obligations instead of restarting the duty. Agreement never proves execution, and a
scope expansion does not inherit an earlier completed outcome automatically.

For third-party work, the main may send the whole workflow, relevant steps or an
adapted plan based on the local workflow, with needed sources and clear roles,
constraints, expected evidence and completion rules. Supervisor recommends this in
its messages; the external plan's internal progress remains unobserved.

For iterative external review, reuse the same authorized ordinary reviewer conversations
for later rounds of that main's work. Send the changed artifact and responses to prior
findings. Other mains own their reviewer conversations; a substantial scope change may
justify fresh ones. A delegated task's backing thread cannot be continued as an ordinary
review chat.

External work for a main-workflow step (an outside agent, tool, service or person)
is reported by the main with an exact `external-contribution` record: use
`awaiting_result` while pending, or `result` directly when a result is available.
Later updates use the next consecutive revision. The root assesses a result
as accepted or needing more work; children relay external outcomes through the main.
Result text and references are untrusted, opaque evidence. Receipt, assessment and
step completion stay separate: neither a finished external task nor an accepted
result completes a step. Do not invent contributor threads or completion for it.

The Task view and Activity are observational. Read timestamps, stale/incomplete warnings,
assessments and source links. Refresh does not wake chats or write workflow state.
Idle/no-AppRun mirrors do not prove completion. Quiet scopes may park while unresolved
work stays unresolved; relevant activity reuses the same Supervisor identity.

Monitoring check-ins become due after ten finished activities by default, or once the
oldest has waited the chosen interval (one or two minutes in Project settings, two by
default), with a 30-second cooldown per main. A busy Supervisor, a check-in in flight or
Stop still defers them, so this is not a reply-time promise. Each check-in records one
outcome: Progress updated, No change, Needs attention or Insufficient evidence.
Supervision shows the last confirmed review and the current one, which may be awaiting
confirmation, not confirmed or missing. Only a confirmed outcome acknowledges the
reviewed activity. A missing or unconfirmed one leaves it pending, and the third
consecutive miss needs Retry. The Supervisor sends corrective guidance only for a
concrete operative mistake. An outcome or guidance is its assessment, not proof that the
operative corrected anything.

## Stopping supervision of one chat

- Use the selected chat's Stop supervision button in its Supervision view; Enable supervision resumes it.
- In the Supervisor conversation, ask it to stop; it calls `supervision_stop` itself.
- In the supervised chat, ask the assistant to tell its Supervisor; the Supervisor cites your original message.
- From another chat in the same T3 environment, name the exact chat ID in your request; that chat's assistant calls
  `supervision_stop` with your message ID.
- Say it in your own words, in any language, for example "Stop supervising this chat." or "Ferma la supervisione di
  questa chat."; the assistant judges your request. A message naming two chats does not stop supervision; the assistant
  then says so, and points to the Stop supervision button.
- Removing a chat from, or adding it to, the excluded chats in Settings is the same Enable or Stop.
- A stop survives restarts, cancels unsent check-ins and settles only the Supervisor conversation, even if it was
  pinned or kept active before the stop. If supervision contacted the operative, one concise notice tells it to stop
  replying to the Supervisor. The task continues; other chats and the project remain unchanged. Pending or uncertain
  notice delivery is shown separately and never causes a fresh replay.

## Teams and native actions

The team view distinguishes the root, direct helpers and operational children.
Inspect readiness, assignments, handovers, unknown delivery and issues. Helper limits
are 0–20, default 5; lowering a limit preserves existing helpers. Membership and scoped
assignments are managed by the owning root, not by messaging a helper. Uncertain
handover does not prove coverage; quarantine revokes service authority, not the
native conversation. An interrupted handover can be reviewed through a root-requested
review, which never proves its effects absent. Read the reference before any requested team change.

Pending owner input defers guidance; Supervisor does not answer it. Late steering
can start a new native turn. Unknown delivery is reconciled before retry or reroute;
do not wake another chat to bypass uncertainty. There is no pre-first-tool barrier.

Workflow MCP is separate from the dashboard. Only the current owning root/helper's
exact native tool evidence and scope authorize writes; a transport credential or
supplied thread ID does not. Preserve exact returned IDs and inspect bounded protocol
diagnostics in their source chat. Product use does not authorize proxies, T3
modifications or manufactured agreement/activity evidence.

The owning Supervisor submits its task interpretation through
`supervision_interpretation_submit`, discovered through the instance's native MCP
connection. Final chat prose is not an interpretation result. A submitted or pending
result is not an agreement: wait for the source-linked state and actual proposal/
acceptance. The service derives delivery from the existing binding; never supply a
different destination or manufacture a submission for another conversation.

## No Project activation

Shared home definitions supply policy; enabling them never starts supervision.
Instance Settings offers Off, On request (default), or Automatic for No Project.
The master switch still overrides all modes. Ordinary projects keep their existing
activation behavior.

In On request, use Home's short recent/search picker or paste a native T3 link,
then choose Start supervision. A finished request is not replayed: the next request
is supervised. Alternatively ask the agent in the desired No Project chat to start
supervision; it may call supervision_start for its own chat using the original human
message. A pending result is not active, and a rejected request contacts no agent.
Start persists until explicit Stop. Settlement parks the same Supervisor and does
not revoke permission. Do not start merely because a task looks substantial.

Chat settings lists relevant explicit exclusions and search-to-add. Hidden or
unavailable IDs remain saved. Removing an exclusion is an explicit Enable, not a
way to enable the whole No Project group. Stop notices show the caller, original
human-message ID and time; Home's Review and enable opens that conversation's
scoped control. No extra confirmation or semantic reapproval is required for Stop.
