---
name: use-t3-supervisor
description: Use an existing T3 Supervisor dashboard to edit repository project rules, inspect workflow blocks, configure project model/reasoning and live monitoring thresholds, inspect draft workflows and steering availability, or adjust chat settings. For product usage, not source development, deployment, credentials provisioning, or Lima VM setup.
---

# Use T3 Supervisor

The dashboard uses one project rule model backed by `.t3-supervisor/rules.yaml` and
reusable Markdown blocks. Legacy condition/message reminders are retired. The Supervisor
proposes draft workflows mixing ordinary task steps with project rules and blocks, introduces valid new drafts
through active steering, and discusses them using native T3 messages. Ongoing
check-ins use the existing T3 activity source. Matching structured confirmations
from both chats produce a saved agreement; neither a draft nor an agreement proves
that its steps were executed or that the code complies.
Task interpretation uses an automatically created T3 conversation per main operational conversation. Independent mains in one
project have separate Supervisors; descendants belong to their main scope.

## Connect

Use the environment's supplied dashboard URL. Mac default is
http://127.0.0.1:9008; the Lima lab is http://127.0.0.1:19008 through its existing
forwarder. Loopback refers to the client machine. Inspect current controls before
acting; the dashboard handles CSRF automatically and needs no login code.

Usage does not authorize changing network exposure, T3, deployment or credentials.
Workflow MCP availability depends on the installed revision and explicit connection
setup; do not infer availability from the source checkout. The dashboard does not
provide a manual workflow-write control. Operational agents propose refinements
through their owning Supervisor, which retains authority over the main and native
descendants. See the product's `docs/workflow-mcp.md` for that separate interface.

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

Missing setup can be created through the explicit checkout setup below. Malformed files, invalid blocks, symlinks and incomplete listings require repair in the repository. The editor only writes existing regular rule
files. A missing write credential is a trusted deployment-setup task, not authority
to provision or retrieve it through ordinary dashboard usage.

## Enable supervision and set up definitions

Settings → Global supervision is the master override, initially enabled.
Projects → Project supervision has a persistent per-project switch. Initial defaults
follow `.t3-supervisor` presence; unavailable reads never imply absence. Disabling
retains chats/history and stops new service work; an active native model may finish.

Settings → Use global rules and blocks is independent and initially off. First ON
creates empty `~/.t3-supervisor` scaffolding if missing, preserves existing files and
leaves them uncommitted. `~` is the T3 server user's home, not the container's.
Enabled projects read shared definitions plus their operative checkout's definitions.
Scratch requires this global input and has no local fallback.

When a project's first enable needs setup, choose its exact checkout and inspect the
shown folder/branch. **Create** leaves setup uncommitted; **Create + commit** submits
the two new setup paths to native T3 and needs a Git-capable target plus trusted
commit/probe grants. Repository hooks and signing apply; inspect staged files/history
after an uncertain result. Enable existing definitions uses the selected checkout
without writing or committing files.
Neither switches branches. After an unknown outcome, reload and inspect; do not
repeat creation or claim a commit without confirmed success.

## Configure the project Supervisor

Under Projects, choose a model and reasoning from the connected T3 catalog, then
Save Supervisor settings. This preference is project-wide, including its worktrees.
When enabled, the service creates one Supervisor for each main operational conversation's first
new task and reuses it on resume. Saved models/reasoning are defaults for new chats
only; edit existing Supervisors using their native T3 controls. Select a main
conversation to inspect its current model, task and scoped retry action. Project
root shows defaults only. Unavailable models remain visible without a fallback.

Configure ongoing monitoring in the same form: maximum pending age
(default five minutes) and finalized activities per operative chat (default ten).
Saving applies these limits on the next service check without losing pending
changes or restarting the service. The fixed per-Supervisor cooldown is sixty seconds;
each Supervisor has at most one service-originated check-in in flight. Other mains
remain independently supervised. A busy supervising chat can
delay an otherwise due check-in.

Inspect monitoring status and pending counts before Retry native access. Existing
Supervisor conversations keep their native modes; a mode mismatch requires an
explicit change in T3's conversation controls, then retry. Newly created chats
use full-access/default for native messaging parity. Their role permits native
reading/messaging and, where available, scoped workflow MCP edits. Role instructions
do not enforce a tool sandbox; workflow writes require separate native evidence.

Select an operational conversation to inspect its interpreted objective and status.
Inspect the draft workflow, ordered block steps, rule applicability decisions and
source workspace/revision. Ordinary steps show a name and reason without a block
reference. Required project blocks remain explicit references in the plan.
Inspect the current draft separately from the last agreed workflow, including its
acceptance time and native message evidence. A stale agreement is retained as
history. Chat confirmation records, rather than a dashboard approval button,
establish agreement; a casual yes does not save it. Missing
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
verification. Source means the original task prompt and workspace/definitions;
ordinary implementation-code edits do not invalidate a workflow. Do not claim
that draft or agreed plans prove execution or rule compliance.

Project definition review is advisory: no dashboard approval is required. The
Supervisor uses the same two chats to check actual user authorization, request
restoration of unrequested agent edits, and negotiate a fresh plan. Changed files
do not automatically replace the active task's saved definitions. Explicit rule
editor saves are user input and still stale the old agreement. Inspect Checking,
Revert requested, Authorized or Restored states and their evidence details. This
does not prevent filesystem writes or provide GitHub comment escalation.

## Idle lifecycle

After completed main work, a final confirmed check-in and a quiet minute, the
controller can settle the owned Supervisor chat. Pending work/input, uncertainty,
active children, pins or keep-active choices prevent parking. Resuming the main
wakes the same Supervisor; settlement does not invalidate its agreement. Unknown
settlement has a scoped Retry native access action. Automatic child check-ins and
direct child guidance remain planned work. Connected child workflow storage and
MCP editing have a separate source/installation boundary; consult current evidence.
