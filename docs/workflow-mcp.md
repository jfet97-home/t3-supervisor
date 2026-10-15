# Connected workflow editing

The Supervisor maintains a broad editable plan for an ordinary main conversation
and a lightweight connected workflow for each native descendant. Steps can run in
parallel, overlap between children, and change as understanding improves. One
child can contribute to several parent steps and expand those into its own subflow.
Each parent occurrence's contributor thread IDs are the association source; child read
results derive their parent-step references from it. These are participation links,
not exclusive assignments or task dependencies. Child completion does not complete
parent steps automatically.

Editable plans are separate from accepted agreements. The existing native
proposal/acceptance checks import each freshly validated agreement as an immutable
historical snapshot. A first agreement seeds an empty plan; later agreements do
not overwrite an already edited plan. Structural edits clear a plan's matching
agreement pointer. A retained pointer only means the plan content matches a
historical accepted snapshot; current task-source and definition validity remain
part of the existing agreement/recovery system. Neither acceptance nor an
observation note proves execution.

## MCP interface

The service provides a stateless Streamable HTTP MCP route at `/mcp/workflows`.
Register it under the exact server alias `t3-supervisor-workflows` when authorized
to configure a connection. MCPX connects directly to Supervisor; do not add HTTP
proxies or relay sidecars to adapt the connection.

Every MCP request requires `Authorization: Bearer <workflow-token>`. The service
creates the private token at `<DATA_DIRECTORY>/access/workflow-mcp-token` on first
startup and preserves it across restarts. Configure this header privately in MCPX;
never put its value in docs, conversation text or source control. The dashboard's
login token and short-lived session cannot authenticate MCP, and the MCP bearer
cannot authenticate dashboard APIs. Transport access grants no native write authority.

`WORKFLOW_MCP_HOSTS` is a comma-separated list of exact accepted `host:port` values
for this route, in addition to its actual loopback address. Foreign browser Origin,
cross-site requests and browser preflight are rejected. Dashboard Host/Origin/CSRF
checks remain independent, and every dashboard API also requires an authenticated
session header. The dashboard uses origin-scoped browser storage and no auth cookies.

On a host-network deployment, optional `WORKFLOW_MCP_BIND_HOST` starts another
listening socket in the same Supervisor process, serving only `/mcp/workflows`.
`WORKFLOW_MCP_PORT` defaults to the dashboard port. This lets the dashboard stay on
loopback while the actual MCP endpoint binds directly to a private Docker bridge.
Missing bind interfaces fail startup; no forwarding service or proxy is involved.
For the Lima lab the MCP listener is `172.19.0.1:19008`, with dashboard loopback
`127.0.0.1:19008`. Mac containers use their existing shared private network and
direct `http://t3-supervisor:9008/mcp/workflows`.

A successful read through the installed gateway establishes transport/permission
behavior, not a positive workflow edit or complete configured-project dialogue.

`workflow_read` takes the Supervisor thread ID and binding generation as lookup
coordinates. It returns bounded workflow state and native main/descendant lineage,
including child parent-step references and archive flags. Reads require the shared MCP transport token but are not
actor-authenticated to a particular T3 conversation and grant no edit authority.
`workflow_write` supports three actions:

- `ensure_main` creates an unaccepted main draft.
- `link_child` creates a live child's workflow under its verified native parent.
- `apply` revises the editable plan with an expected revision and retains
  explicit notes for status changes and removed steps. Existing occurrence IDs are stable and separate from definition IDs;
  repeated reusable references remain distinct, and new nodes begin planned. Read the current document before refining it.

A valid unaccepted draft can be edited: formal agreement is not a write gate.
The controller supplies the current task's trusted canonical proposal and a fresh
matching valid definition snapshot; live edits cannot self-authorize their source
binding or weaken fixed/required commitments. Invalid/incomplete source material
supports provisional dialogue, while source-bound writes wait for a valid pin.

Stored workflow documents and immutable receipts use `formatVersion: 2`. Plans
retain nested groups and per-occurrence `nodeId` values separately from reusable
`definitionId` or task-local `localId` values. The service derives the task ID,
task source hash and definition source binding from its current trusted proposal
and fresh definitions; public arguments cannot supply a weaker policy. Fixed commitments already accepted or
present in the live plan survive a changed proposal ID for the same task source
hash and definition pin. Editing the operative task message creates a new task
source for negotiation, even when its stored task ID is retained. A merely
unaccepted draft candidate is still negotiable. An explicitly reviewed, adopted
new source revision may replace the previous commitments.
Old prototype documents remain explicitly incompatible and are not migrated or
silently reinterpreted; their historical rows and unrelated service state remain.

Apply requires `operationId`, `workflowId`, `expectedRevision` and `note`. Status,
objective, requirements, plan and evidence are optional; omitted plan fields are preserved
from the current document inside the revision-checked transaction. This permits a
status or objective change without resending an entire plan. A supplied plan replaces the nested plan, retaining stable occurrence identities.
A supplied requirement list replaces its accounting; reusable provenance, fixed
commitments and current-task policy are revalidated. Status changes still require explicit status-change evidence.

Each write includes `supervisorThreadId`, `bindingGeneration`, a stable unique
`operationId`, and the complete action arguments. The first two fields locate the
binding to verify; they are untrusted claims. Expected revisions prevent parallel
edits from silently overwriting each other. On uncertain delivery, retry identical
arguments with the same operation ID. Different content needs a different ID.
IDs are scoped to the owning Supervisor binding and edit namespace; another owner
can use the same string independently. Validated agreement imports have a separate
namespace, so edit IDs cannot block their history.

## Write authorization

The service derives project/main scope from the current ready Supervisor binding.
It verifies an actual native `dynamic_tool` item in that Supervisor's own main run,
then reads complete input through T3's existing `orchestration.getTurnItem` API.
The run, thread, provider thread, strong native reference and own main-node graph
must match, with no parent item or non-execution marker. Only exact configured
direct aliases or the exact MCPX call wrapper/inner tool name are accepted. The
full structured object input must equal the complete submitted arguments.
Writes currently accept only the verified `codex` native driver. `claudeAgent` and
other drivers return `native_driver_unverified` until their coverage is authorized
and verified. The ordinary agreement/dialogue path remains separate.

Quoted JSON, ordinary messages, code-mode script text, empty placeholders,
truncated strings and tool calls in another conversation or a native child cannot
authorize an edit. Static provider credentials and gateway tags do not identify a
thread. The service snapshots verified evidence and the operation outcome
atomically, with a final owner/generation/effective-enable check. Exact authorized
replays retain their original result; conflicting operation/evidence reuse fails.

Fresh coherent native active/archive inventory establishes ancestry. Independent
launches and forks are separate scopes. The target workflow and any new
contributors must belong to the owner's scope. Existing participation is retained
on the same stable step ID, including after a child is archived or deleted; it is
historical association, not a claim that the child is still active. Adding a child
to another step is new participation and requires a live descendant. Archived,
nondeleted descendants retain their workflows; new links require live children.
Archiving the main suspends the scope.
Native evidence and lineage are fresh point-in-time reads before the local commit;
there is no atomic transaction with T3, so a concurrent native rollback/archive can
race those reads. Disabling
supervision or replacing the Supervisor blocks old writes while retaining workflows
and history. Settlement preserves the binding for reuse.

Tool recording can lag behind the HTTP request. Missing evidence returns a bounded
pending result and leaves the workflow unchanged; retry the same arguments later.
Unverified intake cannot reserve an authorized operation ID. Input/history limits
fail explicitly rather than silently dropping requirements or history.
Write arguments cap at 192 KiB UTF-8; native detail must remain a complete object
within its 256 KiB limit. Snapshot summary strings only locate candidates and
never authorize them. Store documents cap at 512 KiB UTF-8 and 500 history entries;
there is no history compaction in this foundation. Oversized single-document reads
fail explicitly instead of returning an empty page that cannot advance.

## Verification boundary

This mechanism assumes the integrity of T3's provider-derived history under the
existing non-hostile same-user scope. It is not an OS isolation boundary against
an actor who can alter the local T3 database. Additional providers require verified
native recording behavior before relying on their tool evidence. No T3 source,
installed app/server, startup script or initial dispatch path is modified.

The foundation does not add automatic child check-ins, per-step execution proofs,
progress UI, a task scheduler, or a pre-start negotiation barrier. Those remain
separate roadmap work. Consult T3 Lab's three maintained tracking documents for
source checks, remote review, staged VM evidence and the installed revision.

## Local access and rotation

Dashboard sign-in uses a freshly forged one-time token, valid for five minutes.
Run `t3-supervisor auth forge` as the service account, from any directory. A direct
installation uses the same user state directory for service and CLI; Docker/VM
users run it inside their deployment environment. Custom state paths use the same
DATA_DIRECTORY or `--data-dir /absolute/path` for both commands. The CLI requires initialized
private auth state. The login page shows this exact portable command. Private
SQLite stores only pending token hashes, and consumption is atomic/durable, so a
used token cannot replay after restart. Independent state directories reject one
another's tokens. The long-lived workflow MCP token remains a separate0600 file
under0700 access, accepted only for MCP transport.

Do not use T3/provider credentials for these roles. To rotate the MCP bearer,
replace only its file with a fresh canonical32-byte base64url token, restart
Supervisor and update only the matching MCPX header. Existing dashboard sessions
are invalid after restart. Preserve all other service state; a volume reset is
never a login recovery method.
