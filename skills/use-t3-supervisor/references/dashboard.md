# Dashboard workflows

The current views are Projects, Activity, Recaps and Telegram, and Settings.
Projects is the default. Older Guidance rules screenshots describe retired UI.

## Project rules and blocks

Select the actual registered project and optionally a conversation belonging to it.
Confirm the displayed working directory; a conversation can use a worktree. The
page loads on selection or Refresh definitions, not background snapshot polling.
An unavailable selected conversation never silently switches to the project root.

Inspect validation, rules, required-block links, instructions and expected results.
Edit project rules modifies the same existing `.supervisor/rules.yaml` used by manual
repository editing. Name, description and required_blocks are the sole rule fields.
The description explains applicability; blocks describe work and its expected result.

Before saving, confirm the exact target, particularly an active conversation's
working tree. Changes remain uncommitted in the project; saving does not commit,
push, execute blocks or activate a negotiated workflow.

## Drafts and conflicts

Drafts persist across dashboard sections and temporary connection failures.
Switching project/workspace, refreshing or cancelling asks before discarding an
unsaved draft. Browser navigation also warns about unsaved or in-flight changes.
During a save the editor and selection controls are disabled.

A changed workspace, raw rules or block definitions rejects a stale save. The draft
is kept. Copy or reconcile the intended changes before Refresh definitions and
explicitly confirm discarding the old draft. An uncertain result likewise requires
inspection/reload, never an automatic retry or a success claim. A session-guard
rejection is definitely not saved: the dashboard refreshes access, keeps the draft
editable and asks for a new explicit Save. It never retries that write itself.

Missing files are created manually in the repository in this step. Malformed files
and block errors must be repaired before editing. Native target checks reject
symlinked paths and incomplete listings; external changes racing the actual native
write remain outside the V1 contract.

## Supervisor model, task interpretation and workflow drafts

Supervisor preferences belong to the project, independently of the rule editor's
selected working directory. Model and reasoning choices come from native T3
capabilities. Save stores the preference; the service applies it while idle and
shows the separately observed current model. It automatically creates one bound
conversation when a task first needs interpretation, then reuses it.

Model drafts follow the same explicit refresh/conflict/session-guard rules. A
request whose save outcome is unknown is never automatically repeated. Direct T3
model edits can race with dashboard application; refresh to inspect the result.
Select a task conversation to see a source-linked objective or its unavailable/
needs-context state. This stage does not propose or agree a workflow.

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

Select an operational conversation to inspect its workflow proposal. The ordered
steps identify existing project blocks; rule decisions explain their applicability.
The workspace and definition revision identify the snapshot used. Unavailable,
invalid or stale proposals do not become agreed workflows. Legacy objective-only
records remain unchanged. This stage does not send the draft to the agent.
