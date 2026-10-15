# Project definitions

Supervisor reads `.t3-supervisor/project.yaml`, reusable Markdown steps in
`steps/` and YAML workflows in `workflows/` through T3's native file API. It does
not need repository mounts or execute definitions. The complete syntax is in
[steps and workflows](steps-and-workflows.md), also explained by the dashboard's
Guide. The earlier rules/blocks prototype is replaced without migration; existing
instance settings, identities and unrelated history remain.

## Sources and validation

The selected conversation's operative checkout supplies local definitions. A root
selection reads the registered project root. Enabled global definitions use the
same layout in the T3 server user's `~/.t3-supervisor`, with visible source paths
and namespaced references. Global inclusion and both scopes participate in revision
identity. Caller-supplied filesystem roots are never accepted.

```text
GET /api/guidance/project-configuration?projectId=<id>&threadId=<optional-thread-id>
```

The snapshot includes workspace/thread identity, revision, status, issues, steps,
workflows, configuration, bounded readable sources, and `complete`. Completeness
means fully observed, not syntactically valid. Complete invalid collections can
retain a revision for safe correction. Missing folders, denied permissions,
transport failures, truncated listings and malformed files remain explicit.
Partial observations never become an empty requirement list.

Validation checks fields, identifiers, duplicate keys, references, composition
bounds and direct/indirect workflow cycles. Reusing a workflow in independent
branches is valid. Diagnostics include the cycle chain. The UI shows readable
material and errors; the Supervisor still receives bounded diagnostic context and
can negotiate a finite provisional plan. Unresolved required/fixed commitments
stay visible, and invalid references are never expanded indefinitely.

Definitions are working-tree observations, not immutable policy attestations.
Native filesystem permission covers the T3 environment; Supervisor restricts
requests to the selected definition paths. Reads can follow symlinks within the
workspace. These checks do not provide OS isolation or atomic filesystem enforcement.

## Dashboard inspection

Projects shows reusable steps, workflow composition, requirements, source paths
and diagnostics. Refresh definitions after repository edits or a workspace change.
Definition reads are explicit, separate from ordinary polling. Switching selection
cancels the old request; stale results cannot replace a newer workspace. An
unavailable selected conversation never silently falls back to root.

The Guide explains syntax and FAQ independently of any configured project. Steps
have only `id`, `name` and `description`. Workflow contents use `sequence` and
`parallel`; `step` accepts an ID or local step object, while `workflow` accepts a
named reference only. Required means inclusion for the current main task; fixed
preserves original commitments and relationships while allowing added work between
them. Neither inclusion nor an accepted plan proves execution or delegation.

## Editing project configuration

The configuration editor writes only the existing regular
`.t3-supervisor/project.yaml`. It edits the complete `required` list and optional
`default_workflow`, using valid reusable catalogs. Steps and workflows remain
repository-authored files. An empty requirement list is `required: []`.

```text
POST /api/guidance/project-configuration
```

The payload is `projectId`, nullable `threadId`, `expectedRevision`, and `config`.
The response distinguishes saved, conflict, invalid, permission_required,
unavailable and uncertain, with fresh definitions when available. Native writes
need separate trusted credentials; dashboard usage does not provision them. Saving
configuration does not authorize independent edits to step/workflow definitions.

Each save confirms the exact checkout target, serializes writes per workspace,
rechecks revision and conversation binding, and verifies fresh readback. YAML
comments on retained nodes are preserved where possible; formatting can change.
Missing paths and incomplete reads require repository repair rather than implicit
file creation. Setup is a separate explicit action with existing grants/Git preflight.

Drafts survive navigation, conflicts and expired authentication. An uncertain
outcome blocks another write until inspection/reload. Definite authentication
rejection keeps the draft and requires another explicit Save after sign-in;
refreshing access never automatically replays it. Host/Origin, session/CSRF and
request size guards still apply.

Native truncate/write is non-atomic and has no filesystem compare-and-swap.
Preflight cannot prevent an external edit or symlink swap immediately before the
write, and readers can observe partial contents. Failed readback means unknown
saved state, not success or permission to retry automatically.

## Credentials and unrelated history

Read setup supplies `filesystem:read`; config writes use the separate
`T3_PROJECT_WRITE_TOKEN_FILE` filesystem read/write grant. Setup commits and the
clean-Git probe retain their separate credentials. Supervisor never self-grants.
Dashboard sign-in and workflow MCP bearer authentication are independent of these
native permissions and of per-Supervisor write authority.

The retired condition/message reminder evaluator remains inactive. Its history
and uncertain notices are retained without replay. See
[project supervision](project-supervision.md) for dialogue/definition-change review,
and [workflow MCP](workflow-mcp.md) for connected mutable plans and authority.
