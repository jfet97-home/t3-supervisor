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
proposal through native active steering. T3 delivery semantics can queue or start
a follow-up when active delivery is unavailable. Definite rejection and uncertain
delivery remain distinct; possibly accepted messages keep their original identity
and are never blindly retried as a new effect. This is not a pre-start barrier;
implementation may already have begun. Setup scripts remain deferred.

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

Ongoing checks reuse T3 activity with project age/count thresholds (initially five
minutes or ten finalized activities), independent per-main cooldowns and one
service check-in in flight per Supervisor. Quiet completion/archive/deletion can
settle the owned chat once children and pending work are quiet; resume reuses its
identity. Settlement is not deletion or agreement invalidation. Automatic detailed
child monitoring and execution proofs remain separate work.

Native creation/request identities and owned IDs are permanent recovery evidence.
Retry native access reconciles the original uncertain action. A confirmed deleted
Supervisor exposes a distinct replacement action; an archived one is restored in
T3. Stop/restart/provider failures do not erase user history; native rollback can
invalidate source evidence. Unknown outcomes stop at the retained bounded retry
budget and do not become confirmed success.

Settings saves use generation checks. Drafts survive conflicts and connection or
authentication failures; reauthentication never automatically repeats a rejected
write. Existing private state, instance settings, ownership and unrelated Telegram
history survive definition-format replacement. Old prototype plans are not valid
new-format plans; no migration or broad state reset is required.

Native frames, task inputs, prompt size, response size, queued/lifetime records,
owned identities and workflow documents have explicit bounds. Overflow remains
visible rather than truncating policy. Native chats use T3/provider context
management; the separate optional recap worker is not the workflow Supervisor.
See [workflow MCP](workflow-mcp.md) for exact write authorization, size limits,
receipts and mutable-plan history. Source tests, staged VM proof and actual service
deployment are separate claims; current installed revisions belong in Lab tracking.
