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
revision. A valid new draft can then be introduced to the operational agent
through native active steering, after the supervising conversation has received
its dialogue context. This can arrive after implementation has already started;
it does not create a startup barrier or undo earlier edits.

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

New supervising conversations use full-access/default modes so that T3's native
messaging permission checks allow contact with ordinary development conversations.
Interpretation turns retain their no-tools contract. Dialogue and check-in turns
instruct the model to use only `t3_thread_read` and `t3_thread_send`, and to avoid
repository edits, commands, delegation and settings changes. The conversation
runs in the project root: these role instructions are not an enforced tool sandbox.
Existing conversations retain their modes and are never automatically upgraded.
If their modes cannot contact an operative chat, the dashboard reports the mismatch;
change the modes explicitly in that conversation's T3 controls and Retry native access.

## Saves and availability

A stale settings generation rejects a concurrent dashboard save. Drafts survive
connection failures and stay available after conflicts. Unknown save outcomes
require an explicit refresh; rejected session guards refresh access without
repeating the write automatically. Model changes apply only when the Supervisor
is idle, and existing requests retain their original identity through uncertainty.
Monitoring-only saves advance the dashboard save generation but preserve the
separate model-mutation generation, so an unresolved model update keeps its native
command identity. Interpretation timeouts start at the native run's actual start;
time spent queued is not counted as model execution time.

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

## Dialogue and active steering

After validating a new draft, the service initializes the supervising conversation
with the task, complete project definitions and proposal identity. It then sends
one introduction to the operative conversation using native `steer_active` when
a compatible run is running. Starting and waiting runs use queue delivery. A
definite steering rejection permits one queued attempt with new message/command
identities, retaining the rejected attempt; an uncertain effect never triggers
that fallback. The introduction explains the Supervisor's role, the proposed
steps, the `.supervisor` paths and how to reply or suggest other available blocks.
With an idle target, native queue/start semantics can start a follow-up. A run
that finishes during steering can also receive a follow-up under T3's own behavior.

The agent replies directly to the supervising conversation using `t3_thread_send`
with queue mode, its operative thread ID and proposal ID. The Supervisor can read
the operative conversation and send contextual guidance using auto mode, which
steers a supported active turn or queues when necessary. If the agent lacks that
tool, its finished reply remains available for the next check-in. T3 stores the
dialogue; there is no separate transcript database. The dashboard continues to
show an unconfirmed draft. Structured acceptance, agreed-workflow storage and
per-block execution state remain future work.

Unknown native effects retain their exact message/command identities and original
bytes. They are reconciled from the relevant conversation, with an explicit Retry
native access action before replay. A receipt establishes acceptance; a projection
establishes that the introduction is visible. Neither proves that the agent followed it.
An accepted introduction that remains invisible is reported after a bounded wait;
it does not stall other operative conversations. Deleted targets are reported
separately. Explicit recovery rechecks accepted effects rather than duplicating
them; a confirmed rejection can be retried with fresh identities.
Completed objective-only records are not retrospectively activated.

## Ongoing check-ins

The service reuses T3's shell inventory and full active conversation projections;
it does not install another monitor. It checks introduced conversations in bounded
batches, normally no more often than every 30 seconds per conversation.
Only finalized activity contributes: completed commands/tools, messages, plans and
file changes. Thinking, partial streamed text and the service's own introductions
do not trigger check-ins. Pending input and run finish/failure are priority changes.

For each operative chat, a check-in becomes due when its oldest unreviewed activity
is five minutes old, ten activities have completed, or there is a priority event.
There is a fixed 60-second gap between service notices to one project's supervising
chat, and one service request in flight. Busy chats accumulate activity for later;
five minutes is a scheduling threshold, not a guaranteed response deadline.
Counts are per operative chat, with bounded fair selection across chats.

Notices contain typed counts, statuses and native item references, plus the task's
draft context. They do not contain command outputs or streamed text, and are not
model summaries. The supervising model reads relevant messages/items on demand
and decides whether to intervene. Frozen activity revisions are acknowledged only
after the specific native request completes with its completion marker and no
intervening human message. Native peer replies do not invalidate a check-in by
themselves. If a peer restart replaces the request's primary message, the request
settles without acknowledging its activity. Changes observed during the review
remain pending. Each included chat freezes its entire pending scope; the model
receives a fair preview of up to 20 item references per chat and 100 per project,
with counts and instructions to read further where needed. A large burst is not
split into repeated notices solely because its preview is smaller.

Projects exposes a pause control, an interval of 1–60 minutes and an activity
threshold of 3–100. Changes apply on the next service check without a restart or
discarding the backlog. A lower limit can make one combined notice due after the
cooldown; it does not generate a burst. Model changes still wait for an idle run.
Metadata and native requests persist in the existing private guidance database.
Capacity limits and unresolved deliveries are surfaced rather than silently
discarding unreviewed activity. Completed check-ins with unconfirmed output retain
their activity and retry after the cooldown, stopping after three consecutive
misses. Other failed or uncertain effects need explicit native recovery.
Completed request history retains the latest 100 entries per project for up to
30 days; unfinished and unacknowledged failed reviews are preserved separately.
Activity metadata is capped at 1,000 rows per chat. Fully acknowledged closed runs
advance the source floor and release their reviewed metadata, so ordinary completed
runs do not consume a lifetime quota. A single dense active run can still reach
the ceiling; overflow and incomplete coverage are reported and prevent floor
advancement. Native reactivation of a previously closed run rewinds the floor to
that live main-graph run, within the original activation boundary. A batch freezes
at most 10,000 item revisions across 100 chats.

This feature does not execute required blocks, attest compliance or enforce
protected operations. Deterministic gates remain deferred.

## Startup timing

The installed T3 Nightly exposes post-dispatch monitoring and steering, not an
external pre-start callback. Its native `defer_start` dispatch mode must be chosen
by the initial sender. Observing a newly created run and interrupting it can race
with provider startup; `holdQueue` holds queued work rather than pausing the current
run for later resumption. Guaranteeing workflow negotiation before the first
provider call requires control over T3's initial dispatch path. This stage keeps
agent startup unchanged and does not implement a startup barrier.
