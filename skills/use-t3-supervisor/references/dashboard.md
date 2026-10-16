# Dashboard workflows

The current views are Projects, Guide, Activity, Recaps and Telegram, and Settings.
Projects is the default. Older Guidance rules screenshots describe retired UI.

## Sign in

Enter the owner-generated single-use sign-in token in the sign-in page. The login
page shows `t3-supervisor auth forge`. For a direct installation, run it as the
service account from any directory. For Docker or a VM, run it inside that
environment. A custom state directory must match the service's DATA_DIRECTORY or
`--data-dir` option. This mints a fresh token valid for five minutes. Tokens come
from private service state and must not be put in chat or a URL. Ordinary usage
does not authorize retrieving or provisioning credentials. The browser stores only
an eight-hour session for that exact origin, with no auth cookie. Supervisor
restarts preserve it until its original expiry. A new tab or expired session can
require sign-in again. Sign out revokes this session durably.
After reauthentication, review an unsaved draft and choose Save explicitly; the
page never repeats a rejected mutation automatically.

## Steps, workflows and project configuration

Select the actual project and optionally a matching conversation. Confirm its
working directory; definition reads follow the operative checkout, not a root
fallback. Refresh explicitly after repository edits. Inspect source paths,
reusable steps, nested workflows, requirements, completeness and diagnostics.
The Guide contains complete syntax examples and FAQ independently of this selection.

The project configuration editor saves the existing local project.yaml, with
required step/workflow references and optional default_workflow. Effective global
requirements remain separate and read-only. Step/workflow catalog definitions
are authored in the repository. Confirm the target before Save. This leaves files
uncommitted and does not execute or accept a workflow.

## Drafts and conflicts

Drafts persist across dashboard sections and temporary connection failures.
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
capabilities. Save stores defaults for new Supervisors and shows the selected main conversation’s
separately observed model. Each main gets its own bound Supervisor automatically.
Edit existing models in T3. Independent requests and retries do not cross mains.

Model drafts follow the same explicit refresh/conflict/session-guard rules. A
request whose save outcome is unknown is never automatically repeated. Refresh to inspect native model changes. Project root has no selected binding.
Select a task conversation to see a source-linked objective or its unavailable/
needs-context state. Matching native proposal/acceptance records save a semantic agreement, not execution evidence.

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

Select a main conversation to inspect current main and child workflow state in the
live progress section. This is separate from task proposals and historical accepted
plans. The view includes native/delegated lineage and lifecycle, current semantic
steps, overlapping parent contributions, recent Supervisor assessment notes and
supporting activity links. Missing child workflows and unknown lifecycle remain
visible without synthesizing successful execution. Load further pages when offered.

Refresh reads state only: it does not wake a chat, save a workflow or accept a plan.
A refresh failure retains the last successful data with an explicit stale warning.
After switching main/project, never interpret the old main's data as the new scope.
Incomplete native scope, incompatible state and unavailable reads require attention;
they do not mean an empty or completed workflow.

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
rows accompany otherwise due root work/events without repeatedly waking it. The dashboard
keeps failed, uncertain, delivered-but-unacknowledged, and superseded notices visible.

The team snapshot includes an observation time. Incomplete or unavailable state is
explicit; after a refresh failure, retained data is stale. Opening a T3 link does
not make the team data fresher. Team and progress reads do not wake chats or change
workflow state. During a handover, the root remains responsible until the new
coverage is confirmed; an uncertain notification is not evidence that a transfer
completed.

Direct guidance is limited to verified active delegated children and active-only
steering after fresh scope and contact checks. Native read-only children receive
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

## History and chat settings

Activity displays retained earlier supervision records; Recaps and Telegram shows
notification and questionnaire/cleanup records. Inspect an item and open its exact
originating chat. Expired details are unavailable evidence, not reconstructed facts.
Legacy reminders no longer evaluate, preview or send; old uncertain outcomes remain
retained and read-only without reset or reconciliation controls.

Settings → Chat settings controls excluded chats and the interactive Telegram chat.
Changes apply live and persist in the instance state volume. Mac and Lima policies
are independent. The interactive chat can answer questionnaires even when excluded
from other notifications. The Telegram integration is completely optional.

Select an operational conversation to inspect its workflow proposal. The nested
plan preserves sequence/parallel structure, occurrence identity and provenance;
requirement decisions explain inclusion, non-applicability and unresolved policy.
The workspace and definition revision identify the snapshot used. Unavailable,
invalid or stale proposals do not become agreed workflows. Legacy objective-only
records remain unchanged. The service introduces valid drafts and batches later check-ins.

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


Grant and session hashes share one private access/login.sqlite3 database. The
service and forge command use its current schema; old experimental schemas are
not supported automatically. Login commits grant consumption and session creation
together. Existing session expiry and durable sign-out are unchanged. Maintenance
preserves real credentials and sessions without requiring product compatibility
layers for obsolete prototypes.

Helper check-ins use a genuine event-triggered T3 webhook task bound to the child,
without a timer or T3 Connect. The native job appears in T3's scheduler. Pausing or
retargeting it stops delivery; the service does not silently undo that choice.
Webhook credentials remain private. Unknown POSTs are not repeated; native message
and delivery evidence reconcile the original attempt. A definite failed check-in
needs an explicit root retry or reassignment.
