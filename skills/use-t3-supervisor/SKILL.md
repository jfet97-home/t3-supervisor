---
name: use-t3-supervisor
description: Use an existing T3 Supervisor dashboard to inspect steps and workflows, edit project configuration, configure Supervisor defaults and monitoring, inspect agreements and history, or adjust chat settings. For product usage, not source development, deployment or credential provisioning.
---

# Use T3 Supervisor

Each ordinary main conversation has one Supervisor shared by native descendants.
Projects reads the operative checkout's `.t3-supervisor/project.yaml`, `steps/`
and `workflows/`; enabled global definitions are additive and visibly namespaced.
The Guide explains definitions, syntax and FAQ without requiring a configured project.

## Connect

Use the supplied dashboard URL: Mac default http://127.0.0.1:9008, Lima lab
http://127.0.0.1:19008 through its existing forwarder. Sign in with an owner-generated
single-use token entered privately in the page. The page shows
`t3-supervisor auth forge`; run it as the actual service account in its environment,
with matching DATA_DIRECTORY or --data-dir if customized. Ordinary usage does not
authorize extracting/provisioning tokens or changing network exposure/deployment.
Sessions belong to the exact origin and expire after eight hours. Supervisor
restarts and deployments preserve valid sessions; Sign out revokes them durably. Expired authentication keeps drafts; sign-in never
replays a rejected mutation automatically.

## Definitions and project configuration

Select a registered project, optionally a matching conversation's worktree. Check
the actual source path, load time and diagnostics. Refresh after repository edits;
an unavailable conversation must not silently fall back to root. Complete-invalid
and partial reads differ: neither means no requirements. Definition problems stay
visible while the Supervisor can discuss a finite provisional plan.

Steps contain only id, name and description. Workflow contents use sequence or
parallel groups, step references/local step objects, and named workflow references.
There is no inline keyword or inline workflow definition. All guidance, results,
applicability and delegation belong in description. Required references belong to
the current main task; fixed protects original commitments and relationships while
allowing support work between original members. Repeated references are distinct
occurrences. Read the in-app Guide for examples and failure cases.

Within the requested scope, edit project configuration and confirm the exact
working-tree target. The editor writes only the existing regular project.yaml:
local required step/workflow references and optional default_workflow. Global
requirements are read-only, separate from editable projectConfig. Steps/workflows
are authored in the repository. Empty local requirements are required: []. Saving
does not commit files, execute work or prove compliance. Missing paths, incomplete
reads or unsupported source content require repository repair/trusted setup.

Conflict or uncertainty keeps the draft and requires inspection/reload before
another write. Native writes are non-atomic; external changes can race preflight.
A definite authentication rejection is not saved and requires a new explicit Save.
Read [dashboard workflows](references/dashboard.md) for these distinctions.

## Controls and setup

Global supervision is the master override; project switches remember manual
choices. Initial project defaults follow observed folder presence, not unreadable
material. Disabling preserves history/identity while a native running turn may finish.
Separate global definitions are opt-in under the T3 server user's home, not the
Supervisor container's. Scratch requires that global input.

First setup selects an exact checkout/branch. Create leaves project.yaml and
steps/.gitkeep/workflows/.gitkeep uncommitted. Create + commit requires a safe clean
Git target and separately provisioned commit/probe grants. Hooks/signing apply;
after uncertainty inspect actual files/index/history rather than repeat creation.
Enable existing definitions writes nothing. Neither action switches branches.
Usage does not authorize provisioning missing filesystem, commit or probe grants.

## Supervisor, plans and history

Project model/reasoning choices come from the native catalog and are defaults for
new Supervisor chats. Edit existing chats in T3; no silent model substitution.
Select a main to inspect actual binding/model, objective, proposal, agreement and
recovery. Native mode mismatches need an explicit T3 change before scoped retry.
Project-root view shows shared defaults only.

Monitoring uses native activity and project age/count thresholds, independent
per-main cooldowns/requests. Saved changes apply on the next check. There is no
pause-monitoring mode. Supervisors run through T3; optional Telegram recaps use a
separate worker/authentication scope.

Inspect nested plans, requirement accounting, source revision and diagnostics
separately from native acceptance evidence and actual execution. Required inclusion
can be recursive. Children can contribute to multiple parent steps with overlapping
personal workflows; child completion never completes the parent automatically.
Delegating an entire review workflow is described in its description; merely naming
it does not prove independent review or follow-up. Agreements require matching
structured native messages; casual assent is insufficient. Changed definitions
retain stale history until reviewed and a fresh agreement is established.
Configuration saves authorize only local config, not independent catalog edits.
The Supervisor can request restoration/renegotiation but does not prevent writes.

The workflow MCP is a separate installed capability. It has no dashboard write
button. Only the current owning Supervisor's exact native tool evidence can
authorize edits to its main/descendant scope; transport credentials alone cannot.
Check actual installed availability, not source checkout features. Role instructions
are not a sandbox. No proxies or T3 modifications are authorized by ordinary usage.

Activity and Recaps and Telegram retain read-only history. Settings stores chat
exclusions and optional interactive Telegram selection per instance. Preserve
uncertain sends/receipts; questionnaires use their native answer path, not ordinary
messages. Idle scopes may settle and later reuse the same Supervisor; deletion,
archive, failed reads and settlement are distinct. Retry native access reconciles
original identities, never resets state. Report actual saved/live evidence and any
unverified limit; acceptance, plan status and execution remain separate facts.


Grant and session hashes share one private access/login.sqlite3 database. The
service and forge command use its current schema; old experimental schemas are
not supported automatically. Login commits grant consumption and session creation
together. Existing session expiry and durable sign-out are unchanged. Maintenance
preserves real credentials and sessions without requiring product compatibility
layers for obsolete prototypes.
