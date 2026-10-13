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

## Task interpretation

The current stage infers a concise objective from a new operational conversation's
primary user task. It uses only a bounded message with verified native provenance,
not tool output, private reasoning or arbitrary excerpts selected by an agent.
Only ordinary root user messages originating from T3 web/mobile are supported at
this stage; scheduled, imported and MCP-originated requests are excluded.

The service sends the bounded task to the project's Supervisor conversation and
accepts only a completed, source-linked structured response. A greeting or unclear
request produces no objective; a later qualifying user request can provide context.
The first accepted objective is retained for that operational conversation.
Activation combines active and archived native snapshots at the same global
revision and stores their run anchors. Old or incomplete baseline formats are
conservatively recaptured. Held/queued requests that have not executed at activation
can be interpreted when they become the presented run.
Select the conversation under Projects to see its interpretation status and result.
This does not send a workflow proposal or interrupt the operational agent.

Supervisor conversation identities are recorded before creation and retained
permanently in the existing private state database. They and their descendants are
excluded from further task interpretation, completion recaps and native-input relay.
The service does not answer questions or approvals raised by a Supervisor run.

The conversation initially uses T3 approval-required and plan modes, plus an
interpretation-only prompt. These are runtime conventions, not a guarantee that
provider tools are disabled. No deterministic safety boundary is claimed here.

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

Inputs are capped at 24,000 characters, native frames/activation snapshots at 8 MiB,
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

Project rule/block loading and editing already exist. Applying those definitions
to interpreted objectives, proposing workflows, observing replies, negotiating
changes and monitoring execution are subsequent steps. This feature does not
execute required blocks, attest compliance or enforce protected operations.
