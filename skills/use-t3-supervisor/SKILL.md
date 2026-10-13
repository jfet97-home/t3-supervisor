---
name: use-t3-supervisor
description: Use an existing T3 Supervisor dashboard to inspect and edit repository project rules, inspect reusable workflow blocks and validation, configure each project's Supervisor model and reasoning, view task interpretations, draft workflows and notification history, or adjust chat settings. For product usage, not source development, deployment, credentials provisioning, or Lima VM setup.
---

# Use T3 Supervisor

The dashboard uses one project rule model backed by `.supervisor/rules.yaml` and
reusable Markdown blocks. Legacy condition/message reminders are retired. The Supervisor proposes draft workflows from project rules and blocks. Dialogue
with the operational agent and workflow progress monitoring are not connected yet.
Task interpretation uses an automatically created T3 conversation per project.

## Connect

Use the environment's supplied dashboard URL. Mac default is
http://127.0.0.1:9008; the Lima lab is http://127.0.0.1:19008 through its existing
forwarder. Loopback refers to the client machine. Inspect current controls before
acting; the dashboard handles CSRF automatically and needs no login code.

Usage does not authorize changing network exposure, T3, deployment or credentials.
There is no Supervisor MCP endpoint to invent.

## Inspect and edit project rules

Open Projects and select a registered project root or a matching conversation's
working directory. Check the source path, load time and validation issues.
Required-block buttons open instructions and expected results. A valid individual
item does not make an invalid collection complete.

Within the user's requested scope, choose Edit project rules. Each rule has a
unique name, a description explaining applicability, and one or more required
blocks selected from that working directory's valid existing blocks. Add, edit or
remove rules, then Save project rules and confirm the exact working-tree target.
An empty saved collection explicitly removes requirements with `rules: []`.

The UI edits the repository file, not a separate configuration database. It preserves
comments on retained YAML nodes where possible; formatting may change. Blocks
remain repository-authored Markdown files in this step.

Missing/malformed files, invalid block files, symlinks or incomplete listings must
be repaired in the repository first. The editor only writes existing regular rule
files. A missing write credential is a trusted deployment-setup task, not authority
to provision or retrieve it through ordinary dashboard usage.

## Configure the project Supervisor

Under Projects, choose a model and reasoning from the connected T3 catalog, then
Save Supervisor settings. This preference is project-wide, including its worktrees.
The service creates and reuses a Supervisor conversation automatically for the first
new task; no manual launch is needed. Saved and current selections differ while a
change waits for the Supervisor to become idle. Unavailable models remain visible
without a fallback. Refresh to verify the actual T3 selection after a change.

Select an operational conversation to inspect its interpreted objective and status.
Inspect the draft workflow, ordered block steps, rule applicability decisions and
source workspace/revision. A proposed workflow is not agreed or executed. Missing
or invalid definitions leave the proposal unavailable; changed definitions produce
a stale result. Legacy objective-only records are not automatically reprocessed.
The first stage handles native web/mobile user tasks, not scheduled/imported/MCP
requests. The bound Supervisor conversation can be opened in T3; it is excluded
from ordinary monitoring and notifications.

## Interpret saves and history

Read [dashboard workflows](references/dashboard.md) for drafts, conflicts, refresh
and history. Confirm saved state through the returned definitions. A conflict or
unknown write keeps the draft: inspect the actual file before explicit reload and
never repeat the write automatically. Native writes are non-atomic; this V1 does
not prevent external edits between preflight and write.

Activity and Recaps and Telegram are read-only history. Acceptance, visible messages
and compliance remain separate facts. Retired uncertain notices stay uncertain;
there are no reset, resend or model-preview controls.

Settings manages persisted chat exclusions and optional Telegram interaction.
Telegram is optional. Answer native questionnaires through their existing T3 or
Telegram paths; ordinary messages do not replace questionnaire answers.

Report the selected project/workspace, actual saved result and any unavailable
verification. Do not claim that a draft proposal means agent negotiation or rule compliance.
