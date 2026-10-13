# Project Supervisor conversations

Projects includes a model and reasoning selector for each registered project.
The choices come from the connected T3 environment's provider catalog, including
its configured models and advertised reasoning options. An unavailable provider
remains visible; the service never silently substitutes another model.

Save Supervisor settings stores the project's preference. It does not start an
operational task or require a manual conversation-creation step. The service
creates one ordinary T3 Supervisor conversation automatically when the first new
task needs interpretation, then reuses it for later tasks in that project.
The initial default is `gpt-6-luna` with high reasoning on the `codex` provider;
choose another available model if that selection is unavailable in the environment.

Saved and current model selections are displayed separately. The service applies
changes through T3 between Supervisor runs and checks the observed selection.
T3 can also disable providers per project; a native rejection is shown explicitly
and releases the affected request rather than silently choosing another provider.
Changes made directly in the T3 conversation are reflected when no dashboard
change is pending. T3 does not offer an atomic model-setting compare-and-swap;
a simultaneous edit from T3 and this dashboard can race. Refresh to inspect the
actual selection rather than assuming a pending setting is already active.

## Task interpretation and draft workflows

The current stage infers a concise objective from a new operational conversation's
primary user task. It uses only a bounded message with verified native provenance,
not tool output, private reasoning or arbitrary excerpts selected by an agent.
Only ordinary root user messages originating from T3 web/mobile are supported at
this stage; scheduled, imported and MCP-originated requests are excluded.

Before dispatch, the service loads `.supervisor/rules.yaml` and all valid Markdown
blocks from the operational conversation's actual working directory through T3.
A ready, complete collection is included with the bounded task in the project's
Supervisor prompt. The model assesses each rule, selects an ordered workflow from
available block IDs, and explains its applicability decisions.
The service accepts only a completed, source-linked structured response. A greeting or unclear
request produces no objective; a later qualifying user request can provide context.
The first accepted objective is retained for that operational conversation.
Activation combines active and archived native snapshots at the same global
revision and stores their run anchors. Old or incomplete baseline formats are
conservatively recaptured. Held/queued requests that have not executed at activation
can be interpreted when they become the presented run.
Select the conversation under Projects to see its interpretation status and result.
The result includes a draft workflow when definitions are available. Each referenced
block must exist, every rule must be assessed, and all required blocks for rules
the model considers applicable must be included. Applicability remains a semantic
judgment, not deterministic enforcement. Before accepting a proposal, the service
reloads the definitions and checks their revision and workspace identity. Changed
or unavailable definitions produce a stale proposal; the interpreted objective
remains available. The dashboard shows the ordered steps, rule decisions and source
revision. It does not send the proposal to the agent or interrupt its execution.

Missing, invalid, unreadable or oversized definitions keep objective interpretation
available but produce an explicit unavailable workflow. Rules and blocks are never
truncated or treated as an empty valid collection. Existing completed objective-only
records are retained without automatic proposal backfill. Failed or malformed proposals
are visible and do not create an automatic model retry loop. Transient definition
read failures retry for up to three attempts, with counters retained through service
restarts. Preparation waits before its model dispatch; completion revalidation
reuses the already completed response. Missing, invalid or permission-denied
definitions immediately make the workflow unavailable. An exhausted read budget
keeps the objective available without an accepted workflow.

Supervisor conversation identities are recorded before creation and retained
permanently in the existing private state database. They and their descendants are
excluded from further task interpretation, completion recaps and native-input relay.
The service does not answer questions or approvals raised by a Supervisor run.

The conversation initially uses T3 approval-required and plan modes, plus a
structured interpretation/proposal prompt. These are runtime conventions, not a guarantee that
provider tools are disabled. Tool-approval requests in a Supervisor conversation
are outside this stage and should remain unapproved. No deterministic safety
boundary is claimed here.

## Saves and availability

A stale settings generation rejects a concurrent dashboard save. Drafts survive
connection failures and stay available after conflicts. Unknown save outcomes
require an explicit refresh; rejected session guards refresh access without
repeating the write automatically. Model changes apply only when the Supervisor
is idle, and existing requests retain their original identity through uncertainty.

Retry native access reconciles an uncertain creation, model update or request
with its original identity. Resolve dirty settings drafts first. A confirmed deleted
conversation exposes a distinct Replace deleted Supervisor conversation action;
the server checks the requested action and binding identity before replacement.
Archived conversations are restored in T3 instead. A settled idle Supervisor can
receive new work normally. Known rejections release the affected request; unknown
outcomes keep their evidence and stop automatic retries when the budget is used up.

Task inputs are capped at 24,000 characters, complete workflow prompts at 120,000
characters and structured workflow responses at 128,000 characters. Native
frames/activation snapshots are capped at 8 MiB,
and baseline threads at 10,000. There are at most 100 queued tasks per project,
10,000 lifetime task records and 1,000 owned conversation IDs. Finished objective
details expire after 30 days while deduplication metadata remains. These are
prototype limits; oversized or unavailable baseline reads keep discovery in its
visible initializing state. Long Supervisor conversations use T3/provider context
management rather than a separate compaction service.

The deployment needs its existing T3 read credential and a separate read/operate
credential for native conversation/model operations. Neither can be supplied or
upgraded from the dashboard. Telegram remains optional and independent.

## Next stage

Project definitions now feed draft workflow proposals. Sending a contextual proposal
to the operational agent, observing its replies, negotiating changes and monitoring
execution are subsequent steps. This feature does not
execute required blocks, attest compliance or enforce protected operations.

## Startup timing

The installed T3 Nightly exposes post-dispatch monitoring and steering, not an
external pre-start callback. Its native `defer_start` dispatch mode must be chosen
by the initial sender. Observing a newly created run and interrupting it can race
with provider startup; `holdQueue` holds queued work rather than pausing the current
run for later resumption. Guaranteeing workflow negotiation before the first
provider call requires control over T3's initial dispatch path. This stage keeps
agent startup unchanged and does not implement a startup barrier.
