# Project Supervisor conversations

Each ordinary main T3 conversation has one reusable Supervisor, shared by its
native descendants. Independent mains and forks have independent scopes. Project
model/reasoning defaults come from the live T3 catalog and apply to newly created
Supervisors. Existing chats keep their native controls; unavailable models are
reported rather than substituted. Project-root selection shows defaults, while a
selected main shows its actual binding, requests and recovery controls.

## Definitions and enable controls

Read [steps and workflows](steps-and-workflows.md) for the definition model and
[project definitions](project-definitions.md) for source selection and editing.
The master supervision switch starts on. Per-project initial defaults follow
observed `.t3-supervisor` presence; saved manual choices persist. Unreadable is not
absent. The separate global-definitions switch starts off, even when the folder
exists. Global definitions are additive and namespaced, using the T3 server user's
home. This supplies policy only and never activates No Project chats. With shared
definitions off, No Project uses task-local steps.

No Project has its own Off / On request / Automatic mode in Instance settings.
On request is the default: discovery creates no root or model work for an unstarted
chat. Start permission applies to one ordinary main and persists across service
restarts and Supervisor settlement until explicit Stop. Off pauses every No Project
scope; returning captures a fresh discovery boundary without revoking permissions.
Normal projects retain automatic folder/manual activation.

Home offers eight recent/search results or an exact native T3 link. Dashboard Start
is authenticated human intent. It pins the latest genuine request only while that
request's native run is unfinished; otherwise it starts with the next request.
The agent's supervision_start tool instead cites its own current genuine human
message. Exact native caller/tool/run proof is mandatory. The Supervisor's first
interpretation returns an independent startRequested verdict before any operative
contact, workflow writes, helpers or monitoring are permitted. A negative or stale
verdict never activates. Stop and mode/source changes fence pending interpretation;
unknown native identities are reconciled and never replaced by a fresh send.
Start operation receipts and permissions use the existing guidance database.
Settings shows relevant explicit exclusions and bounded search-to-add, retaining
hidden/unavailable exclusions. Stop provenance appears in Home and the conversation;
Home's Review and enable opens the exact scoped control.

Disabling stops new service-originated interpretation, introductions, check-ins
and recovery sends. It preserves chats, bindings, requests and agreements; a
running native turn may finish. Re-enabling captures a discovery boundary instead
of replaying all work submitted while disabled. There is no pause-monitoring mode.

First setup selects an exact checkout/branch. Create writes only the new
`project.yaml` (`workflows: []`, then `steps: []`), `steps/.gitkeep` and `workflows/.gitkeep`. Create +
commit requires a clean safe Git state, no in-progress operation/lock, fresh native
Git preflight and the separate commit/probe grants. It never switches branches,
initializes Git or stages unrelated files. Native Git can reset the index, so
cleanliness must be checked immediately beforehand. Hooks/signing can change the
result or leave files staged; uncertain results require inspection, not replay.
Native filesystem/Git actions are not atomic against external changes. Enable
existing definitions adopts the selected checkout without writes or commits.

## Interpretation and working plans

A qualifying new main task is derived from bounded native web/mobile user-message
provenance. Scheduled/imported/MCP-originated requests remain outside automatic
initial interpretation. User/tool quotations, private reasoning and arbitrary
agent-selected excerpts do not establish task authority.

The Supervisor interprets the latest genuine request together with earlier unresolved
requests in the same main, such as an issue link that did not yet establish an
objective; a bootstrap, setup or recovery instruction is treated as a step toward
that request, not its replacement. With the workflow MCP available, interpretation
receives a short manifest of each indexed definition's id, name, summary and
members, and reads complete definitions on demand through `workflow_read` with
`definitionIds`, so full descriptions are not pushed into the prompt. A summary
is navigation, not policy. The operative introduction says that
`.t3-supervisor/project.yaml` is the index and to read the listed full files
it needs. The index is not a whitelist of task plans; negotiated local steps
remain available. A manifest too large for
one request keeps the reader and shrinks to member counts, then to a prefix of IDs and
names, stating what it omitted. Interpretation first
decides whether supervision is needed: a short self-contained communication, lookup
or status request is recorded as `not_supervised` with its reason, gets no proposal,
introduction or check-ins, and the next genuine request is interpreted again. This
semantic decision is temporary; it is unrelated to a human's durable stop.

The Supervisor receives the task, source identity, readable step/workflow material,
configuration and diagnostics. Valid definitions support a source-bound proposal.
Malformed, cyclic, missing or incomplete material remains explicit; it does not
disable the Supervisor agent or become an empty valid policy. A finite provisional
plan can be discussed while unknown fixed/required commitments remain outstanding.
The agent cannot claim a broken workflow has executed merely because it names it.

Plans preserve nested sequence/parallel groups, named workflows, local/reusable
steps, descriptions and provenance. Each occurrence has a stable identity distinct
from its template ID, so repeated references retain separate status/contributions.
Requirements are accounted for once per current main task, including recursive
inclusion. Child contributions may overlap and expand several parent steps into a
personal workflow; completion does not automatically roll up to the parent.

Required controls inclusion; fixed preserves original commitments, relative order
and parallel relationships. Added work may appear between fixed members. Description
text carries applicability, instructions, expected results and whole-workflow
delegation/iteration guidance. The role distinction between main coordinator and
assigned reviewers avoids recursive delegation. No semantic keyword launches an
agent, schedules a task or proves successful execution.

## Dialogue and agreement

Startup is compact. The initialization turn only confirms the service-prepared
proposal by echoing its exact reference `{taskId, proposalId, digest}`; definitions
stay available through `workflow_read`. The operative introduction says that `.t3-supervisor/project.yaml` is the
index and to read the listed full files it needs. It opens with the
obligation to agree a task-relevant workflow before implementing (evidence gathering
and bootstrap work may come first; the Supervisor cannot block tools), then an outline
and the exact acceptance record. Wakes carry the full standing instructions once per
version and afterwards a compact core with their version; full instructions, task
context, definitions and dry-run checks are pulled on demand. Each wake row has one
activity list and per-task context with revision pins, proposal identity and digest,
agreement and repair state. Oversized requests stop before delivery with a visible
reason in Overview and Plan & agreement; pending activity and uncertain delivery identities remain
intact. Retry stays explicit. Blocked startup also stops automatic definition review
and renewal until Retry. Readable definition changes during healthy startup, including
invalid or missing definitions, remain pending context work.

The service initializes the Supervisor's context before introducing a validated
proposal. When the main is idle, queued delivery starts a normal new turn on the main. When
the main has a steerable running turn, the initial proposal targets it with active
steering; a definite rejection uses the existing queue fallback. If the main is preparing, starting,
or its running provider turn is not yet ready to accept steering, the proposal stays
in the existing durable Supervisor ready state until a later check. A running status
alone does not prove that steering is available. Unknown delivery is reconciled
against the original effect identity before any retry; it is never sent again under
a new identity. This is not a pre-first-tool barrier: work may already have begun
when guidance arrives. Setup scripts remain deferred.

Ordinary model guidance to the main uses T3's automatic delivery mode after fresh
reads. Delivery can still fail: an unknown result is reconciled with the original
request before retry, while a confirmed failure waits for a new read and later
reconsideration. There is no retry loop. Check-ins, objective/context introductions
and replies from the main remain separate queued Supervisor turns with separate
request identities.
When an owner question or approval is pending, potentially interrupting guidance
waits; the Supervisor never answers or resolves that native request.

The two bound chats negotiate by native messages. A saved agreement requires a
Supervisor proposal in its own completed message and the exact acceptance reference
in a completed, source-linked main assistant message after the introduction. Casual
assent, streaming text, quoted or nested records, tool output or a subagent's message
cannot establish it. Workspace and definition revision are rechecked. Formal agreement requires current, complete, valid definitions; invalid
or incomplete material supports provisional dialogue, not saved acceptance. Stale agreements remain history; changed candidates require new matching
confirmation. An agreement proves agreement, not execution, delegation or compliance.
An initial service-generated provisional record with no plan can initialize
repair dialogue only when its complete shape and current source context match
exactly. It establishes no agreement or source-bound write authority; those require
a later complete valid proposal.

### Compact dialogue records

Only top-level fences count; a record inside an enclosing code block, a blockquote or
an indented block is inert. A Supervisor proposal is a `workflow-proposal` draft:
`{taskId, taskRevision, proposalId, revision, draft}` with optional `objective`. The
draft holds requirement applicability decisions and a plan of definition IDs, local
steps and groups. `taskRevision` and `revision` are the task source and definition
revisions the author observed; a draft authored against another revision is rejected
with the current value, never rebound. The service derives workspace, names,
descriptions, sources and template paths from the trusted context and canonicalizes
deterministically, so `workflow_read` view `check` returns the same digest before
publication. A proposal ID is immutable: different content under the same ID is a
conflict. An unchanged proposal is reused by its exact `{taskId, proposalId, digest}`
from view `context`, never rebuilt (a rebuilt draft gets different node IDs); only a
changed plan gets a fresh proposal ID. `objective` restates the task from cited genuine user message IDs and
updates the dashboard objective. The initialization turn echoes the prepared proposal
as a `{taskId, proposalId, digest}` reference.

The operative accepts only with a `workflow-acceptance` fence of exactly
`{taskId, proposalId, digest}` naming a stored, formal candidate; the digest covers
the task revision, definition pins and the whole canonical plan. Short
acknowledgements, prose acceptance, extra fields or a reduced object such as
`{"taskId":"…","mainThreadId":"…","proposalId":"…","accepted":true}` do not
establish agreement. Full canonical records published before the compact protocol
remain valid evidence for their own retained agreements only.

When a completed message's record cannot be used, the task stores one bounded
`workflowProtocolDiagnostic` with role, code, the failing path, the expected shape and
a detail code. A rejected Supervisor proposal is repair work: a due wake carries it
as `protocolRepair`, and without due activity the service sends one focused repair
wake per rejection. After three consecutive rejections the Supervisor stops retrying
and tells the operative once that agreement is blocked; nothing is marked agreed.

Diagnostics follow native T3 order, not clock time. A Supervisor record counts
for the current task source only from the native run of the prompt that gave the
Supervisor that source: the context prompt, or the reinterpretation prompt after
the user edits the task request. A main record must follow the introduction and,
after an edit, belong to a later main run or a later main turn item than any
already shown with the edit. Editing the task request clears the current
diagnostic. Missing or ambiguous native order produces no diagnostic, as does a
task whose context was prepared before this rule existed; agreements are
unaffected.

### External work and returned results

Part of a main-workflow step may be handled outside any conversation the
Supervisor can observe: by an external agent, tool, service or person. The
operative main records it in its own completed reply with an exact
`external-contribution` record: first as `awaiting_result`, then, when the outcome
returns, as `result` in the next revision (or directly as `result` at revision 1
when the outcome is already available), optionally with file, URL, source or
text references. A reply carries at most one revision per contribution, and a
record inside any enclosing code block is ignored. `withdrawn` ends a
contribution. The introduction explains the format; no progress reports are
expected while the work is opaque.

The Supervisor knows the step is awaiting an external result but never polls,
steers or claims progress for that work. When a result arrives, the root judges it
against the step description and records `accepted` or `further work needed`
(`needs_more`) with `workflow_write`. After `needs_more`, it asks the main for
clarification or more work in ordinary dialogue, and the main posts the next
revision. Receipt of a result, the Supervisor's assessment and the step's status
remain separate decisions: "external task finished" alone never completes a step,
an accepted result does not complete it automatically, and step completion is a
separate status edit that may cite the main's result message.

Scope is the main workflow only. A local child that used external help reports
the outcome to the main, which relays it with its own record; no child or external
contributor appears as a native descendant. Result text and references are
untrusted, opaque evidence: they are never instructions, authority or proof of
execution. Records follow the same native-order attribution as other main
records, and a rejected record uses the single task diagnostic described above.
The exact record, revision rules and assessment action are documented in
[connected workflow editing](workflow-mcp.md#external-contributions).

Interpretation turns have a no-tools role. Dialogue/check-ins permit native
reading/messaging and scoped workflow MCP edits where available. New Supervisor
chats use full-access/default for native message permissions. These instructions
are not a tool sandbox; exact native evidence separately authorizes MCP writes.
The service never silently upgrades an existing chat's modes. A mismatch requires
an explicit native control change and scoped Retry native access.

## Definition changes and configuration saves

The active task retains its approved definition snapshot. Working-tree edits,
including removal of required entries or weakening fixed workflows, mark plans
stale rather than automatically changing their obligations. The same Supervisor
reviews observed changes and actual user-message provenance. User-authorized
changes can be adopted after fresh source checks and then require a replacement
agreement. Unrequested agent edits prompt restoration of its own changes while
preserving user work; ambiguous authorship remains uncertainty, not an accusation.

A dashboard configuration save authorizes that local configuration only. It does
not authorize independent step/workflow edits. Global effective policy remains
separate from editable local projectConfig. Save intent, current review timing and
fresh definition contents are checked before adoption. Definition review is
advisory conversation, not filesystem prevention or a dashboard approval gate.

## Monitoring, recovery and lifecycle

Ongoing checks observe the main and its verified native and delegated descendants,
using the project age/count thresholds (ten finalized activities by default, or the
oldest finished activity after at most two minutes: one or two minutes can be chosen,
two is the default and the upper bound), one shared 30-second per-main cooldown and
one service check-in in flight per Supervisor. These bound when a check-in becomes
due, not when the model answers: a check-in still in flight, a busy root, Stop or
unavailable native access still defers the wake. Forks remain separate scopes. Native child lifecycle comes from its
direct parent's child record; an idle child mirror with no AppRun is not completion.
Bounded activity batches identify their source and show incomplete reads explicitly.
Completed, failed, interrupted and cancelled runs have terminal priority. Verified
native-child terminal changes use the exact direct-parent record and are routed to
the current root/helper responsible for that child. Priority bypasses age/count,
while the existing cooldown and acknowledgement rules still apply. Repeated reads
of the same terminal version do not create another review.

Each root monitoring check-in names its request and is pinned when it is prepared: the
binding generation and, per included task, its revision and its main workflow (or the
explicit absence of one). The Supervisor assesses the evidence against the agreed
workflow, records verified status changes, and sends the operative concise corrective
guidance when evidence demonstrates a concrete, actionable mistake or deviation; it
stays silent on routine progress and never invents a correction from uncertainty.
Before its marker it records exactly one outcome with `workflow_write` `record_review`
(progress updated, no change, needs attention or insufficient evidence), decided from a
fresh read of the relevant finished messages, results and current workflow: the change
index is navigation, not proof, and no change is never a default. The outcome
is confirmed only when the check-in completed with its marker, the recording call
completed in that check-in's own run and the pins are still current (for no change,
each main workflow unchanged; for progress, each cited edit still in place). Only a
confirmed outcome acknowledges the frozen batch. A missing or unconfirmed outcome is
never read as no change: the batch stays pending and the check-in counts as a miss,
so the next one follows the cooldown and the third consecutive miss requires Retry.
The dashboard's monitoring status shows the last confirmed outcome and the current one
that is recorded, unconfirmed or missing. Recording sends nothing, and an outcome or
guidance is the Supervisor's assessment, not evidence that the operative acted on it.

Fresh native request state controls waiting: resolved, expired or cancelled requests
clear matching stale waiting summaries, while missing or mismatched evidence stays
explicitly unresolved. A genuinely pending owner request remains pending even if
its run has ended. A helper defers intervention on that target rather than sending
guidance to its ancestor around the owner's decision.

The Supervisor assesses adherence and progress from T3 actions, results and visible
context. Agents work normally without continual status reports. The Supervisor can
inspect a specific result to resolve uncertainty, write a short status explanation
and link supporting activity. A tool result or linked item alone does not establish
semantic completion, and child completion never completes a parent step by itself.
Clarification or changed plans are discussed and reflected in the live workflow.

Direct guidance to a delegated child is limited to a verified active child and uses
active-only steering after fresh scope, lifecycle and contact checks. Terminal or
unknown children are not contacted directly. After a definite rejection or when the
child cannot be steered, guidance goes to the nearest verified, eligible and
contactable ancestor within scope; the main is used only when it is valid and the
guidance remains relevant. Native read-only children receive guidance through their
verified ancestor path. An unknown send is reconciled before considering another
route. T3 can turn a late child steer into a started delivery, so there is no
guarantee that steering cannot wake a child. If that happens, the Supervisor stops
sending to the child and notifies the parent when relevant; it does not cancel the
turn automatically. These routing instructions are not a sandbox around the
model's other native tools.

A human can stop supervision of one chat: from the dashboard's selected-chat Stop
supervision control, by telling its Supervisor directly, by asking the operative to
relay the request with the human's original message ID, or from another ordinary chat
in the same environment whose genuine user message names the exact target chat ID.
The assistant that calls `supervision_stop` judges that a genuine human asked to stop, in
any language; the service does not interpret the words. It verifies deterministically that
the cited message is that human's original native message, that the caller's own native
call belongs to it, and that the message names no second chat (the caller's own, a child
chat or another Supervisor conversation; only the target's own Supervisor conversation may
be mentioned) and, from another chat, names the exact target. When a stop is refused, the
assistant tells the human that supervision was not stopped and points them to the
dashboard's Stop supervision control. A stop dates from the human's instruction: a stop
instruction written before the latest explicit Enable supervision, including a replayed
tool call, never reverses it, and repeating an earlier stop never re-dates it.
The stop is saved in the instance thread policy (the same list as the excluded chats;
adding or removing a chat there is the same human Stop or Enable as the dashboard control),
survives restarts, and only an explicit human Enable supervision resumes it. Enable
supervises the chat's next request: a request written while supervision was stopped, or at
or before a project or global activation boundary, is not interpreted; an interpretation queued
before the Enable is closed unsent; one already sent is never applied or resent, and it closes
only once its exactly matched native run has ended, while an absent or still active native
outcome keeps its identity held (these boundaries are rechecked right before dispatch and
before a result is applied); and the Supervisor reviews nothing until the human writes in the
main again. That next request is interpreted afresh even after an interpreted task, unless the
task's introduction was attempted with an unknown outcome (sending, accepted, uncertain, or
accepted but not found), which keeps the task held; a never-attempted draft or a fallback whose
earlier attempts were definitely rejected is known unsent and does not hold it, and an earlier
request's unsent introduction is never sent after that Enable or boundary. Retry native access never resends an uncertain root check-in or introduction: it
only re-observes the retained identity, so a delivery whose native outcome stays unknown keeps
its pair held, across any Stop, Enable or activation boundary, until that outcome appears or the
Supervisor conversation is replaced. A stop
cancels never-sent check-ins, keeps sent and uncertain delivery identities, and sends no new
check-in or introduction. An explicit Stop schedules one concise operative notice per
Enable period, only if supervision previously contacted that main. The notice says to
stop replying to the Supervisor while continuing the task; it never asks for a reply.
Unsent notices are fenced by Enable; accepted or uncertain identities are only observed.
Three visibility misses at least a minute apart park the notice as unconfirmed with
its exact body and IDs. Retry rechecks it without replay; known-unsent blocked notices
can be retried explicitly. Notice wording never asks the operative to resume work.
Historical exclusions are not backfilled. A crash between the separate policy save and
notice reservation can leave a stopped chat without a notice; Stop remains effective.
Notice delivery also runs while supervision is disabled and does not hold settlement.
The owned Supervisor settles promptly on the next idle cycle, without the ordinary
60-second quiet window, once every accepted delivery, the
interpretation request included, has a confirmed native outcome; reconciliation of those
deliveries continues, without sending anything, even while project supervision is
disabled. A root check-in or interpretation whose delivery stays genuinely unknown keeps
the Supervisor active; elapsed time never resolves it. In a team the same
observation-only reconciliation matches accepted helper check-ins and notices to their
native outcome, fences requests and notices that were never posted and closes guidance
awaiting a fallback route as not sent; nothing is sent, retried or retired, and each
service cycle observes with a fresh bounded read budget. On an unsolicited wake the root reads current supervision status first;
a stopped root contacts nobody and finishes so it can settle again. The stop
then waits only for a team effect whose delivery is still genuinely unknown (an
unresolved team request, a notice being delivered, a helper request); review-only
events are superseded by the stop. The stop supersedes earlier keep-active
choices for that Supervisor (pin, disabled auto-settle, reactivation); only such a
choice made after the stop holds it. The operative main is never settled or
interrupted because supervision stopped, and other chats keep their supervision.

Quiet completion/archive/deletion can settle the owned chat once children and
pending work are quiet. A request cancelled before it started executed nothing, so the
latest executed run decides whether the main finished. The binding records the first
gate that keeps an owned Supervisor active as `settlementBlockedBy`, shown in Supervision.
A not-needed or unresolved request gets no check-ins, so unreviewed activity retained from
an earlier request, or a replaced request's known-unsent draft, does not keep its Supervisor
open; both stay as history. An incomplete activity scan or an introduction with an unknown
outcome still does.
An idle main's old lifecycle-unknown child can also permit
standby after the quiet period when no known activity, attention issue or pending
input requires action. Unknown work stays unresolved. Background monitoring
continues and relevant activity reuses the same Supervisor identity and binding;
settlement is not deletion or agreement invalidation. A settled Supervisor is never
woken, and its main never contacted, to review backlog, repair old records, recover
definitions or introduce historical work, for example after re-enabling a project or a
chat, or a deployment. Agent and automated activity in the main stays pending; a genuine
human message in the main after the settle (and after a re-enabled project's activation
boundary) wakes the same Supervisor through monitoring.

## Supervisor teams

The root may recruit direct T3 child conversations as helpers when parallel
monitoring would reduce its workload or context pressure. The Supervisor team stays
flat, while each helper may cover several operational subtree roots and their
verified descendants. The root owns the main, shared policy and unassigned work;
helpers assess and guide only their assigned child workflows. Assignment is
monitoring responsibility, separate from operational task ownership and workflow
contributor links. The default helper limit is five per root; the project setting
accepts zero through twenty, with zero disabling new recruitment while preserving
existing members.

Helpers inherit the root's T3 model by default; the root may select another current
T3 catalog model per helper. A helper receives responsibility only after its native
identity and readiness are confirmed. Handover state and affected helper
notifications remain visible while outstanding effects are settled; the root keeps
responsibility until new coverage is confirmed.

The Projects view keeps the root/helpers separate from operational conversations,
and labels child rows with their effective assignee. It reports observed readiness,
lifecycle, assignments, assessments, pending handovers and issues without turning
missing data into root ownership. The [Supervisor team guide](supervisor-team.md)
explains the view and the T3 messaging semantics: direct human messages follow
T3's native behavior, while root-to-helper notes use Supervisor team operations,
not raw `t3_thread_send`.

The progress view is separate from definition authoring, proposals and saved
agreements. It reads current main/child workflows, lifecycle and recent Supervisor
observations without waking chats or changing plans. Missing child workflows,
unavailable reads and incomplete scope are shown explicitly. Activity references
are checked against fresh native scope and activity before storage; they explain
the assessment without granting write authority. Historical agreement snapshots
remain plans, not execution receipts.

Native creation/request identities and owned IDs are permanent recovery evidence.
Retry native access re-observes the original uncertain action; it never resends an uncertain
root check-in or introduction. A confirmed deleted
Supervisor exposes a distinct replacement action; an archived one is restored in
T3. Stop/restart/provider failures do not erase user history; native rollback can
invalidate source evidence. Unknown outcomes stop at the retained bounded retry
budget and do not become confirmed success.

Settings saves use generation checks. Drafts survive conflicts and connection or
authentication failures; reauthentication never automatically repeats a rejected
write. Existing private state, instance settings, ownership and supervision history
survive definition-format replacement. A saved definition snapshot in the
previous configuration shape stays history: it is not migrated or reset, and
fresh context requires a current index read. Old prototype plans are not valid
new-format plans; no migration or broad state reset is required.

Native frames, task inputs, prompt size, response size, queued/lifetime records,
owned identities and workflow documents have explicit bounds. Overflow remains
visible rather than truncating policy. Native chats use T3/provider context
management for project and workflow supervision.
See [workflow MCP](workflow-mcp.md) for exact write authorization, size limits,
receipts and mutable-plan history. Source tests, staged VM proof and actual service
deployment are separate claims; current installed revisions belong in Lab tracking.
