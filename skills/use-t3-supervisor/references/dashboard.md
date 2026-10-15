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
a short-lived session for that exact origin, with no auth cookie. A new tab, expired
session or service restart can require sign-in again. Sign out revokes this session.
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
User pins and the retained keep-active choice can still hold settlement.
