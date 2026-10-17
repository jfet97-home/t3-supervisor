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
home. Scratch requires this opt-in global input.

Disabling stops new service-originated interpretation, introductions, check-ins
and recovery sends. It preserves chats, bindings, requests and agreements; a
running native turn may finish. Re-enabling captures a discovery boundary instead
of replaying all work submitted while disabled. There is no pause-monitoring mode.

First setup selects an exact checkout/branch. Create writes only the new
`project.yaml` (`required: []`), `steps/.gitkeep` and `workflows/.gitkeep`. Create +
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

The two bound chats negotiate by native messages. A saved agreement requires
matching structured proposal and full-plan acceptance in completed, source-linked
main assistant messages. Casual assent, streaming text, tool quotations or a
subagent's message cannot establish it. The structured record envelope has exactly
`taskId`, `proposalId`, `workspaceRoot`, `revision` and `workflow`. Its workflow is
the canonical plan value (definition status/completeness, requirement knowledge,
requirements, issues and nested plan), without presentation fields. The combined
revision binds global input too; globalRevision remains separate proposal/source
metadata rather than a second top-level record field. Workspace and definition revision are
rechecked. Formal agreement requires current, complete, valid definitions; invalid
or incomplete material supports provisional dialogue, not saved acceptance. Stale agreements remain history; changed candidates require new matching
confirmation. An agreement proves agreement, not execution, delegation or compliance.
An initial service-generated provisional record with no plan can initialize
repair dialogue only when its complete shape and current source context match
exactly. It establishes no agreement or source-bound write authority; those require
a later complete valid proposal.

### Canonical dialogue records

Use the exact fenced `workflow-proposal` and `workflow-acceptance` records published
for the current task. Both have exactly five top-level fields:
`taskId`, `proposalId`, `workspaceRoot`, `revision` and `workflow`. The complete
`workflow` value has `definitionsStatus`, `definitionsComplete`,
`requirementsKnown`, `requirements`, `issues` and `plan`. Preserve the whole
service-published value, including generated node IDs, canonical source metadata,
contributor thread IDs, nested `templatePath` values, workflow omissions and other
canonical plan fields. These values bind the record to the task, workspace,
definition revision and exact candidate; do not regenerate, omit or summarize them.
Object key order is insignificant, but field values, text and array order must match.

Raw proposal or MCP draft input, such as requirement applicability plus a plan,
is only input for service canonicalization. It is not a native chat record and
cannot substitute for the complete canonical proposal. While no candidate is
recognized, the Supervisor's bounded input may include service-generated canonical
authoring examples to show the record shape. Examples are guidance only: they are
not proposals, agreement, requirement-applicability decisions or authority. Preserve
explicit issues and omissions when definitions or obligations are incomplete;
do not silently drop known requirements. Canonical node objects retain all fields,
including `null` and empty-array values, and trusted source/provenance. New wrapper
groups use `templatePath: null`; do not invent or derive paths.

A valid `workflow-proposal` is a candidate for discussion, including when it is
provisional. The operative
main assistant can establish agreement only with a completed `workflow-acceptance`
that echoes the same five-field envelope and the entire canonical workflow value.
Short acknowledgements, partial copies, extra fields, or a reduced object such as
`{"taskId":"…","mainThreadId":"…","proposalId":"…","accepted":true}`
do not establish agreement. `mainThreadId` and `accepted` are not fields in the
acceptance record.

When a completed message's record cannot be used for the current proposal or
acceptance, the task stores at most one current bounded `workflowProtocolDiagnostic`
with its role, fixed diagnostic code, source message ID and observation time. A
new diagnostic replaces the previous one instead of accumulating a separate
history or queue. The dashboard explains that the task still needs dialogue
correction. This diagnostic does not create or remove agreement history, authorize
workflow edits or prove execution; it also does not trigger an automatic retry or
wake a chat.

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
using the project age/count thresholds (initially five minutes or ten finalized
activities), one shared per-main cooldown and one service check-in in flight per
Supervisor. Forks remain separate scopes. Native child lifecycle comes from its
direct parent's child record; an idle child mirror with no AppRun is not completion.
Bounded activity batches identify their source and show incomplete reads explicitly.
Completed, failed, interrupted and cancelled runs have terminal priority. Verified
native-child terminal changes use the exact direct-parent record and are routed to
the current root/helper responsible for that child. Priority bypasses age/count,
while the existing cooldown and acknowledgement rules still apply. Repeated reads
of the same terminal version do not create another review.

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

Quiet completion/archive/deletion can settle the owned chat once children and
pending work are quiet. An idle main's old lifecycle-unknown child can also permit
standby after the quiet period when no known activity, attention issue or pending
input requires action. Unknown work stays unresolved. Background monitoring
continues and relevant activity reuses the same Supervisor identity and binding;
settlement is not deletion or agreement invalidation.

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
unavailable reads and incomplete scope are shown explicitly. Supporting references
are checked against fresh native scope and activity before storage; they explain
the assessment without granting write authority. Historical agreement snapshots
remain plans, not execution receipts.

Native creation/request identities and owned IDs are permanent recovery evidence.
Retry native access reconciles the original uncertain action. A confirmed deleted
Supervisor exposes a distinct replacement action; an archived one is restored in
T3. Stop/restart/provider failures do not erase user history; native rollback can
invalidate source evidence. Unknown outcomes stop at the retained bounded retry
budget and do not become confirmed success.

Settings saves use generation checks. Drafts survive conflicts and connection or
authentication failures; reauthentication never automatically repeats a rejected
write. Existing private state, instance settings, ownership and supervision history
survive definition-format replacement. Old prototype plans are not valid
new-format plans; no migration or broad state reset is required.

Native frames, task inputs, prompt size, response size, queued/lifetime records,
owned identities and workflow documents have explicit bounds. Overflow remains
visible rather than truncating policy. Native chats use T3/provider context
management for project and workflow supervision.
See [workflow MCP](workflow-mcp.md) for exact write authorization, size limits,
receipts and mutable-plan history. Source tests, staged VM proof and actual service
deployment are separate claims; current installed revisions belong in Lab tracking.
