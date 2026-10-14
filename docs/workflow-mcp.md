# Connected workflow editing

The Supervisor maintains a broad editable plan for an ordinary main conversation
and a lightweight connected workflow for each native descendant. Steps can run in
parallel, overlap between children, and change as understanding improves. One
child can contribute to several parent steps and expand those into its own subflow.
The parent step's contributor thread IDs are the association source; child read
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

The source provides a stateless Streamable HTTP MCP route at `/mcp/workflows` on
the Supervisor's existing UI listener. Register it under the exact server alias
`t3-supervisor-workflows` when authorized to configure a connection. Installation
and connection setup are separate from source implementation; a source checkout
does not establish that the running service exposes this route.

The route retains the listener's exact loopback Host, Origin and cross-site browser
guards. Machine clients do not use the dashboard's CSRF token. Dashboard mutation
routes retain their CSRF checks. Do not relax those protections to connect a gateway;
use the intended address/Host mapping. No HTTP identity header grants write access.
Node fetch may ignore a configured Host override. The VM fixture used a temporary
proxy inside the gateway's network namespace to forward from loopback with the
required Host/Origin; it was removed after testing. Connection setup must verify
the actual transport mapping rather than assume an override is effective.

`workflow_read` takes the Supervisor thread ID and binding generation as lookup
coordinates. It returns bounded workflow state and native main/descendant lineage,
including child parent-step references and archive flags. Reads are not
actor-authenticated under the same-user loopback scope and grant no edit authority.
`workflow_write` supports three actions:

- `ensure_main` creates an unaccepted main draft.
- `link_child` creates a live child's workflow under its verified native parent.
- `apply` revises the editable plan with an expected revision and retains
  explicit notes for status changes and removed steps. Existing step IDs are stable;
  new steps begin planned. Read the current document before refining it.

Apply requires `operationId`, `workflowId`, `expectedRevision` and `note`. Status,
objective, rules, steps and evidence are optional; omitted plan fields are preserved
from the current document inside the revision-checked transaction. This permits a
status or objective change without resending an entire plan. Supplied rules/steps
replace those arrays. Status changes still require explicit status-change evidence.

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
