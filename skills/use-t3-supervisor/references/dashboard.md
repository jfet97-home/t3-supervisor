# Dashboard workflows

The main navigation is Home, Projects, Activity and Settings, with Guide as a utility link. Home prioritizes current attention, supervised conversations with their objectives and freshness, then recent activity. Historical activity is not an unresolved-alert count. Native activity and Supervisor assessment remain separate. Unavailable projects and failed refreshes report limited coverage; retained data does not establish current health.

Projects has Conversations, Definitions and Project settings. Open a conversation for Task and Supervision. A project remembers its last context in this browser tab. Hash addresses preserve project, conversation/checkout and view; an explicit address wins over remembered state. Definitions requires an explicit checkout choice: Project root or the checkout a main conversation works in; once chosen, the Checkout control shows its path and changes it. Switching project views retains that checkout draft. Unavailable selections never silently change checkout.

- Task is the one workspace for the conversation's task: its statement, current outcome and current steps, one plan, and the agent/Supervisor agreement. Step statuses come only from the live workflow bound to the task; a proposed update never resets them. Each step shows its plan note, any accepted or proposed plan note, and the Supervisor assessment recorded for that step. The agreement panel states the proposal and the agent's acceptance once, with the acceptance record, plan provenance (definitions, requirements, revision) and task interpretation in disclosures; a pending update lists its actual changes there. Definition-change review and record diagnostics appear as attention above the plan. Evidence and history holds every Supervisor record, external contributions, native lifecycle, earlier acceptances and unlinked earlier workflows. A current assessment must match both the task identity and source. Failed, loading and incomplete reads remain distinct from absence.
- Supervision shows the bound Supervisor, team, assignments, monitoring details and explicit access recovery. Stop/Enable supervision is scoped to the selected chat; the Task view links here when recovery is needed.
- Definitions shows read validity, effective requirements, reusable steps/workflows, collapsible raw sources and the local project.yaml editor.
- Project settings first states which conversations are supervised (the supervision switch, first setup and the off-by-default **Supervise conversations created by agents** checkbox), then the defaults for new Supervisors (model, monitoring, helper limit). It works without a selected conversation. That checkbox lets the agent that launched an ordinary conversation through T3's MCP server have its later requests there interpreted and negotiated, still attributed to that agent; Supervisor conversations, helpers and delegated child tasks are never included, and Start, Stop and definition approval remain human-only.

Instance Settings contains the master switch, global definitions, exclusions and
connection information. Advanced setup help is collapsed. Guide explains the file
format independently of any selected project.

## Sign in

Enter the owner-generated single-use sign-in token in the sign-in page. The login
page shows `t3-supervisor auth forge`. For a direct installation, run it as the
service account from any directory. For Docker or a VM, run it inside that
environment. A custom state directory must match the service's DATA_DIRECTORY or
`--data-dir` option. This mints a fresh token valid for five minutes. Tokens come
from private service state and must not be put in chat or a URL. Ordinary usage
does not authorize retrieving or provisioning credentials. The browser stores only
a 30-day session shared across tabs and browser restarts for that exact origin,
with no auth cookie. Sign out revokes it in every tab. Supervisor restarts preserve
it until its original expiry. Expiry or cleared browser storage requires sign-in again.
After reauthentication, review an unsaved draft and choose Save explicitly; the
page never repeats a rejected mutation automatically.

## Steps, workflows and project configuration

Select the actual project and optionally a matching conversation. Confirm its
working directory; definition reads follow the operative checkout, not a root
fallback. Refresh explicitly after repository edits. Inspect source paths,
reusable steps, nested workflows, requirements, completeness and diagnostics.
The Guide contains complete syntax examples and FAQ independently of this selection.

The project configuration editor saves the existing local `project.yaml` index
only: `workflows` and `steps`, each entry `path`, `summary` and optional `required`,
plus an optional `default_workflow`. A new file is `workflows: []` and then
`steps: []`. The global `~/.t3-supervisor/project.yaml` uses the same format and
stays read-only here. Step and workflow files stay repository-authored. A summary
is navigation; the file is the policy. Confirm the target before Save. Invalid
rows and unsaved drafts remain. This leaves files uncommitted and does not
execute or accept a workflow.

## Drafts and conflicts

Project configuration, Supervisor settings and chat-exclusion drafts persist across dashboard views, the project directory, sign-in expiry and temporary connection failures. The draft notice links back to the appropriate form; Sign out and leave-page warnings cover unsaved changes.
Switching project/workspace, refreshing or cancelling asks before discarding an
unsaved draft. Browser navigation also warns about unsaved or in-flight changes.
During a save the editor and selection controls are disabled.

A changed workspace, configuration or step/workflow definitions rejects a stale save. The draft
is kept. Copy or reconcile the intended changes before Refresh definitions and
explicitly confirm discarding the old draft. An uncertain result likewise requires
inspection/reload, never an automatic retry or a success claim. A session-guard
rejection is definitely not saved: the dashboard refreshes access, keeps the draft
editable and asks for a new explicit Save. It never retries that write itself.

First-time setup offers checkout selection and Create or Create + commit; Create leaves changes uncommitted. An existing folder offers Enable existing definitions without a write or commit. Native commits honor hooks and signing; hooks can change committed contents and failure may leave setup files staged. Shared global setup uses the separate opt-in control in Settings. Incomplete reads and unsupported source errors require repository repair. Native target checks reject
symlinked paths and incomplete listings; external changes racing the actual native
write remain outside the V1 contract.

## Supervisor model, task interpretation and workflow drafts

Supervisor preferences belong to the project, independently of the configuration editor's
selected working directory. Model and reasoning choices come from native T3
capabilities. Save stores defaults for new Supervisors. The selected conversation’s Supervision view shows its separately observed model. Each main gets its own bound Supervisor automatically.
Edit existing models in T3. Independent requests and retries do not cross mains.
When no preference is saved, new roots default to Sol 6.1 with low reasoning;
this does not replace an existing root's model or a saved selection.

Model drafts follow the same explicit refresh/conflict/session-guard rules. A
request whose save outcome is unknown is never automatically repeated. Refresh to inspect native model changes. Project root has no selected binding.
Select a task conversation to see a source-linked objective or its unavailable/
needs-context state. Matching native proposal/acceptance records save a semantic agreement, not execution evidence.

The owning Supervisor returns an interpretation through the typed native MCP tool
`supervision_interpretation_submit`. Its receipt can remain pending while the native
turn completes and the service verifies its source. Final prose or JSON in the chat
is not parsed as an interpretation. A tool submission is separate from a proposal,
operative acceptance and assessed completion. Check the current task and diagnostic
before retrying; keep an uncertain operation's exact identity and bound destination.

Initial proposal delivery follows the main's live state. An idle main receives a
normal new turn through queued delivery. A steerable running main receives targeted active
steering; a definite rejection uses the existing queue fallback. While the main
is preparing, starting or running without a steerable provider turn, the proposal stays
unsent in the existing Supervisor ready state until a later check. `running` alone
does not prove readiness. There is no pre-first-tool barrier, so guidance can arrive
after work begins.

Pending native owner questions or approvals defer potentially interrupting
guidance; the Supervisor does not answer or resolve those requests. Check-ins,
objective/context introductions and replies from the main remain separate queued
Supervisor turns with separate request identities. Ordinary model guidance to the
main uses T3's automatic delivery after fresh reads. An uncertain send is reconciled
with its original identity before retry; a confirmed failure requires a fresh read
before reconsideration.

## Current workflow progress

Select a main conversation to inspect current main and child workflow state in its
Task view. Step statuses come only from the current workflow bound to the task; proposals
and earlier acceptances never change them. The view includes native/delegated lineage and
lifecycle (Connected work), current semantic steps with their step-level Supervisor
records, overlapping parent contributions and supporting activity links (Evidence and history). Missing child workflows and unknown lifecycle remain
visible without synthesizing successful execution. Load further pages when offered.

Refresh reads state only: it does not wake a chat, save a workflow or accept a plan.
Home refresh retains the loaded conversation range, discarding and retrying a changed page sequence before replacing it. Filters apply to loaded rows. A refresh failure retains the last successful data with an explicit stale warning.
After switching main/project, never interpret the old main's data as the new scope.
Incomplete native scope, incompatible state and unavailable reads require attention;
they do not mean an empty or completed workflow.

A main-workflow step may show read-only external contributions reported by the
main for work done outside observed conversations. Labels read "Awaiting external
result", "External result received – awaiting assessment", "External result
accepted", "Further work requested" or withdrawn; contributions for a step removed
from the plan are listed separately as no longer in the current plan. Summaries,
references and external references are the main's untrusted report, shown as plain
text; they are not observed execution. An accepted result does not complete the
step, and the dashboard cannot edit or assess contributions. A
`contribution_*` diagnostic means the main's latest record was not recorded and
explains what needs attention. Follow its specific reason; a missing plan node
can become available after a plan update without changing an otherwise valid record.

Native idle/no-AppRun mirrors are not child completion. The Supervisor observes
normal actions/results and supplies the assessment without requiring constant agent
reports. Its links explain the judgment, not independent proof of semantic success.

## Supervisor team

The selected main's Supervisor team appears in its own section, separate from the
connected operational conversation list. Review the root and direct helpers, their
T3 links, known models, readiness/lifecycle, subtree assignments, current state,
last assessment, handovers and significant issues. Each operational row reports its
effective assignee. A transfer or unknown owner is called out; missing coverage is
not silently shown as root ownership.

The maximum helpers per root defaults to 5 and is configurable from 0 to 20 in
Supervisor settings. Zero stops new recruitment but preserves existing members.
One helper may cover several operational subtree roots and verified future
descendants. Assignment does not change workflow-step ownership, contributor links
or automatic parent completion. Helpers inherit the root's T3 model unless the root
chooses another model from the current configured T3 catalog.

Team membership and assignments are managed through the owning root's Supervisor
team operations. A human message entered in a helper conversation follows T3's
native follow-up behavior. Root notes and routine check-ins go through Supervisor
team operations, not raw `t3_thread_send`. During handover, pending or uncertain
notifications remain visible and the root keeps responsibility until coverage is
confirmed. The root can use the native-proof `supervision_team` action
`quarantine` when it must revoke a helper's service authority before normal
handover completes. Quarantine returns coverage to the root but leaves affected
work observe-only while unresolved requests or delivery effects remain. It does not
stop or cancel the native T3 conversation or a turn already running there. A root
`retry` starts a new attempt only for definite failures when the recipient remains
ready. Unrelated unknown guide effects retain their identities and remain fenced;
failed check-in acknowledgements wait for unresolved member requests. Observe-only
rows accompany otherwise due root work/events without repeatedly waking it. Pending
handovers keep failed, uncertain and delivered-but-unacknowledged notices visible.
Superseded notices were never posted or were definitively rejected; they are closed
and leave that list.

A delivered handover notice whose native run ended before confirming shows "Native
run ended … before confirming; nothing was resent". Its effects are unknown and the
root keeps responsibility. The root can then use the native-proof `supervision_team`
action `review_handover`. It sends a distinct review notice asking the same helper
to inspect the actual effects of every unresolved attempt, including earlier
interrupted reviews, and to perform only genuinely missing duties. The dashboard
labels that notice "Root-requested effect review"; the reviewed notice shows "Root-requested
review in progress; the root keeps responsibility". When the helper's own review run
completes with its marker and current native evidence still shows the reviewed attempt
ended without completing in the same transfer, the reviewed notice shows "Root-requested
review completed by the helper’s native run; this does not prove its effects were
absent, and request fences remain separate" until its transfer ends; otherwise it stays
unresolved. A completed review is notice
bookkeeping only: uncertain guidance and request effects stay fenced, and the
transfer completes only after they settle. If a review is itself interrupted, the next
review again names the original handover and includes the interrupted review in its
chain. An unknown review delivery is never repeated and blocks a further review
until it reconciles. For exact inputs, chain and closure rules, see
`docs/supervisor-team.md` in the T3 Supervisor repository.

The team snapshot includes an observation time. Incomplete or unavailable state is
explicit; after a refresh failure, retained data is stale. Opening a T3 link does
not make the team data fresher. Team and progress reads do not wake chats or change
workflow state. During a handover, the root remains responsible until the new
coverage is confirmed; an uncertain notification is not evidence that a transfer
completed.

Direct guidance is limited to verified active delegated children and active-only
steering after fresh scope and contact checks.
A pending owner request on that target defers guidance, including an ancestor route.
An unresolved fallback appears as deferred for an owner decision and raises bounded
root attention while it remains held; the Supervisor does not answer that request.
Resolved/expired/cancelled native request state clears matching stale waiting hints;
missing or mismatched records remain uncertain. Terminal child changes are priority
observations under the existing cooldown and current assignee, not proof of success. Native read-only children receive
guidance through their verified ancestors. After a definite rejection or when a
child cannot be steered, the Supervisor considers the nearest verified eligible
contactable ancestor, then the main only when that route is valid and relevant.
After T3 returns the specific dispatch failure, the service replays the same native
command once with its original command/message IDs, target and run ID; only a
confirmed definite rejection permits a fresh ancestor check inside the same helper
assignment. A cross-assignment route raises root attention. Generic server errors,
timeouts and lost responses keep the original route. Terminal or unknown children
are not contacted directly, and an uncertain send must be reconciled before another
route is chosen. T3 can turn a late child steer into a
started delivery; if that happens, the Supervisor stops sending to the child,
notifies the parent when relevant, and does not cancel the turn automatically.

## Activity and chat settings

Activity displays retained native project-supervision records. Inspect an item and
open its originating conversation. Expired details are unavailable evidence, not
reconstructed facts.

Settings → Chat settings controls excluded chats per instance. Changes apply live
and persist in the instance state volume. Mac and Lima policies are independent.
Project Supervisors skip excluded chats while preserving existing bindings and
history.

Select an operational conversation to inspect its workflow proposal. The nested
plan preserves sequence/parallel structure, occurrence identity and provenance;
requirement decisions explain inclusion, non-applicability and unresolved policy.
The workspace and definition revision identify the snapshot used. Unavailable,
invalid or stale proposals do not become agreed workflows. Legacy objective-only
records remain unchanged. The service introduces valid drafts and batches later check-ins.

Agreement requires the current full fenced `workflow-proposal` and the operative
main assistant's own completed `workflow-acceptance` with the exact same five-field
envelope and entire canonical workflow value. A short acknowledgement or reduced
`accepted: true` record is insufficient. If the selected task shows a workflow
protocol diagnostic, read its role, fixed code and source message ID, then continue
the dialogue with a corrected complete record in that chat. The diagnostic is
informational and does not alter saved agreement history, authorize edits or prove
execution.
Bounded canonical authoring examples shown in a Supervisor input are only format
guidance, not proposals, acceptance or authority. Preserve explicit unresolved
issues/omissions and all canonical fields, including `null`, empty arrays, source
details and template paths, when continuing the dialogue.

## Enable controls and settlement

The master switch disables every semantic Supervisor. Project switches are independent
and remember manual choices; initial folder presence supplies their defaults. Shared
`~/.t3-supervisor` definitions have a separate opt-in switch and do not replace project
controls. Project definitions follow the operative checkout/worktree; global sources are
marked separately and cannot be edited through the project editor.

Completed idle scopes settle the same owned chat for later resume. Archived/deleted
mains also park their companion once native work and children are quiet, retaining
history and unknown request identities. A native 404 is distinct from a failed read.
User pins and the retained keep-active choice can still hold settlement. An idle
main's old quiet lifecycle-unknown child can permit guarded standby when no known
activity/attention/input remains; unknown work stays unresolved. Monitoring continues
and relevant activity reuses the same companion identity and binding.


Helper check-ins use a genuine event-triggered T3 webhook task bound to the child,
without a timer or T3 Connect. The native job appears in T3's scheduler. Pausing or
retargeting it stops delivery; the service does not silently undo that choice.
Webhook credentials remain private. Unknown POSTs are not repeated; native message
and delivery evidence reconcile the original attempt. A definite failed check-in
needs an explicit root retry or reassignment.


## References and skills on steps and workflows

Reusable step YAML frontmatter, workflow YAML and inline local steps may include
separate optional `references` and `skills` string lists:

```yaml
references:
  - docs/testing.md
  - src/example.ts
skills:
  - .claude/skills/project-testing/SKILL.md
  - effect-v4-development
  - plugin:review
```

Files and local skill paths are relative to the operative checkout root, even for
shared definitions. Skill paths name `SKILL.md` exactly and have no empty, dot or
parent segments. Other skills are exact names from the consuming agent's catalog,
including namespaces. Missing or ambiguous guidance stays an explicit gap; never
guess a host installation path. Omit either list or use `[]` for none. Each list
allows at most 100 entries; skills cannot repeat. Paths allow 4096 characters and
catalog names 256. No scope or object wrapper is used.

Definitions and Plan show separate read-only lists. Edit the source and refresh
to change them. The service loads no target, verifies no existence, installs no
skill and grants no access or proof of reading. Both lists remain part of saved
plans, source identity and fixed commitments. The Guide owns the full syntax and
validation rules.

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
