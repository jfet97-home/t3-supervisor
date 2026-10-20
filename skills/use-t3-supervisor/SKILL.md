---
name: use-t3-supervisor
description: Use an existing T3 Supervisor dashboard to inspect project definitions, workflow plans, agreements, progress and teams, edit project configuration or adjust supervision controls and exclusions. For product usage, not source maintenance, deployment or credential provisioning.
---

# Use T3 Supervisor

Supervisor observes native project conversations and their descendants, discusses
workflow plans and records progress. Telegram communication is a separate service.
For detailed controls and edge cases, read [dashboard workflows](references/dashboard.md)
when using that part of the product.

## Connect and sign in

Use the supplied instance URL; the default is http://127.0.0.1:9008. Localhost refers
to the browser's machine. Enter an operator-provided one-use token privately on the
page. The displayed `t3-supervisor auth forge` command runs in the actual service
environment with matching state. Ordinary dashboard usage does not provision
credentials, expose ports or change deployment.

Five-minute grants produce a 30-day origin-scoped browser session. Restart preserves
its original expiry; Sign out revokes it. Expiry retains drafts and sign-in never
replays a rejected mutation. Inspect uncertain outcomes before another write.

## Projects and definitions

Steps, workflows and inline local steps may carry optional `references` lists of
checkout-relative file paths. Definitions and Plan display them read-only; edit
the source YAML/frontmatter and refresh. Referenced files are not opened automatically.

Open a project from Projects, then choose a main conversation. The project views
are Progress, Plan, Definitions and Project settings. Project root / defaults only
is explicit. Context is remembered per project in the current tab; hash links take
precedence. An unavailable conversation never falls back to another checkout.
Drafts survive switching views, including instance Settings exclusions.

Projects reads the selected operative checkout's `.t3-supervisor/project.yaml`,
`steps/` and `workflows/`. Check source path, workspace, freshness, diagnostics and
completeness; unavailable reads never mean no requirements. Guide explains the
format without requiring a configured project. Global definitions, when enabled,
are separately marked and read-only in the project editor.

Steps have id/name/description. Workflows compose sequence/parallel groups, step
references/local steps and named workflow references. Instructions, applicability
and delegation belong in description. Required references apply to the current main
task; fixed protects original nested commitments and relationships while permitting
support work. Repeated references have distinct occurrences.

Edit only the requested project configuration and confirm the working-tree target.
Save writes local project.yaml requirements/default workflow, leaves files
uncommitted and does not edit the step/workflow catalog. Empty requirements use
`required: []`. Refresh/reconcile conflicting or uncertain writes; Discard removes
an unsaved draft. A definite authentication rejection requires a new explicit Save.

First setup selects the exact checkout/branch. Create leaves files uncommitted;
Create + commit requires a safe clean target and already provisioned access, honoring
hooks/signing. Enable existing definitions writes nothing. Neither action switches
branches. Missing native permissions require operator setup, not credential work
hidden inside a dashboard task.

## Controls, plans and progress

The global supervision master switch overrides remembered project choices. Global
definitions are separately opt-in in the T3 server user's home; scratch needs that
input. Model/reasoning choices are defaults for new roots; edit existing chats in T3.
Settings chat exclusions are per-instance, persistent and independent of Telegram.

Select the actual main to inspect its binding, objective, proposal, agreement,
current workflow and native descendants. Plans preserve nested structure, stable
occurrence IDs and provenance. Child contributions may overlap; child completion
does not complete a parent step automatically. Required inclusion can be recursive.
Matching complete native proposal/acceptance records establish agreement, not actual
execution. Keep incomplete requirements and source issues visible.

Progress and Activity are observational. Read timestamps, stale/incomplete warnings,
assessments and source links. Refresh does not wake chats or write workflow state.
Idle/no-AppRun mirrors do not prove completion. Quiet scopes may park while unresolved
work stays unresolved; relevant activity reuses the same Supervisor identity.

## Teams and native actions

The team view distinguishes the root, direct helpers and operational children.
Inspect readiness, assignments, handovers, unknown delivery and issues. Helper limits
are 0–20, default 5; lowering a limit preserves existing helpers. Membership and scoped
assignments are managed by the owning root, not by messaging a helper. Uncertain
handover does not prove coverage; quarantine revokes service authority, not the
native conversation. An interrupted handover can be reviewed through a root-requested
review, which never proves its effects absent. Read the reference before any requested team change.

Pending owner input defers guidance; Supervisor does not answer it. Late steering
can start a new native turn. Unknown delivery is reconciled before retry or reroute;
do not wake another chat to bypass uncertainty. There is no pre-first-tool barrier.

Workflow MCP is separate from the dashboard. Only the current owning root/helper's
exact native tool evidence and scope authorize writes; a transport credential or
supplied thread ID does not. Preserve exact returned IDs and inspect bounded protocol
diagnostics in their source chat. Product use does not authorize proxies, T3
modifications or manufactured agreement/activity evidence.
