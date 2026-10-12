---
name: use-t3-supervisor
description: Use an existing T3 Supervisor dashboard to configure guidance rules and scopes, preview conditions, inspect activity and notification history, or adjust monitoring settings. For product usage, not source development, deployment, credentials provisioning, or Lima VM setup.
---

# Use T3 Supervisor

T3 Supervisor provides an owner dashboard for monitoring active T3 work, sending
configured guidance, and inspecting Telegram notification and questionnaire history.
Its semantic guidance is advisory; it does not enforce protected operations.

## Connect to the dashboard

Use the dashboard URL supplied by the user or configured for the current environment.
The existing Mac installation uses `http://127.0.0.1:9008`. This address refers to
the machine running the browser or HTTP client; it does not reach the Mac from a VM.
If the dashboard is unavailable, report the access problem rather than changing
network exposure, deployment or credentials as part of ordinary usage.

Use the available browser interface and inspect current controls before acting.
The local dashboard opens directly and handles write protection automatically.
There is no supervisor MCP tool to invent or T3 orchestration command to substitute.

## Configure guidance

Read [dashboard workflows](references/dashboard.md) for rule editing, scope selection,
delivery settings, history inspection and ambiguous outcomes.

For a new rule, capture the observable condition, exact guidance text and intended
scope. Use Observe only unless the user has authorized sending. Evaluate examples
with the preview before enabling delivery; preview consumes detector budget but
sends no messages. Read back the saved rule and its actual mode after a change.

Sending requires the dashboard to report write readiness and the owner's acceptance
of the documented delivery race. Existing authorization should be respected; do not
ask again for a change the user has already requested. Missing write capability is
an installation issue, not permission to retrieve or provision credentials here.

## Interpret results

Activity distinguishes detection, holds, delivery acceptance and message visibility.
None proves that the target followed the instruction. A finishing target may receive
a follow-up turn instead of an interruption. Unknown delivery must be reconciled;
do not reset an episode or repeat a send merely to see whether it works.

Recaps and Telegram history is read-only. It cannot resend a notification or answer
a questionnaire. Keep those requests on their supported user-facing paths.

Report the scope and saved behavior, what was actually observed, and any unavailable
evidence. Usage does not authorize changes to T3, the supervisor service or its state.
