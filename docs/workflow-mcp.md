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

## Native workflow proposal and acceptance records

Native chat negotiation uses compact top-level fenced records; they are separate from
`workflow_write` arguments and receipts, and a record quoted inside another block is
inert. The Supervisor publishes a `workflow-proposal` draft with exactly `taskId`,
`taskRevision`, `proposalId`, `revision` and `draft` (plus optional `objective`) in its
own completed message. The draft contains requirement applicability decisions and a
plan of definition IDs, local steps and groups. The service binds it to the observed
task source and definition revisions, derives workspace, names, descriptions, sources
and template paths from the trusted definitions, and canonicalizes it with
deterministic node IDs. A changed plan needs a fresh proposal ID; reusing an ID for
different content is rejected.

The operative main assistant records agreement only in its own completed message
after the introduction, with a `workflow-acceptance` fence of exactly
`{taskId, proposalId, digest}` naming a stored formal candidate. The digest covers the
task revision, definition pins and the whole canonical plan. A short acknowledgement,
a reduced `{taskId, mainThreadId, proposalId, accepted: true}` object, prose or extra
fields do not establish agreement. Full canonical records published before this
protocol remain evidence for their own retained agreements only. MCP transport access
and a successful `workflow_write` remain separate capabilities and cannot stand in for
native-message agreement.

The current task stores at most one bounded `workflowProtocolDiagnostic` with its role,
code, failing path, expected shape and detail. A new diagnostic replaces the previous
one. A rejected Supervisor proposal becomes focused repair work in the next wake and,
after three consecutive rejections, a visible blocker; it never changes agreement
history, authorizes an edit or proves execution.

## External contributions

Some work for a main-workflow step happens where the Supervisor cannot observe it:
an external agent, tool, service or person. The operative main records that work
in its own completed reply with an exact fenced `external-contribution` record. The
record is generic and provider-independent; it names no provider, carries no
credentials and grants no remote polling, steering or workflow-write authority.

The fence holds one single-line JSON object with exactly these fields, all present:

- `taskId`: the current task.
- `contributionId`: the main's stable ID, at most 64 characters of `A-Z a-z 0-9 . _ : -`.
- `nodeId`: an existing step or workflow node in the current main workflow plan.
- `revision`: an integer of at least 1.
- `state`: `awaiting_result`, `result` or `withdrawn`.
- `summary`: at most 2,000 characters of untrusted text.
- `references`: at most 8 `{kind, value}` objects, where `kind` is `file`, `url`,
  `source` or `text` and `value` has at most 500 characters; may be empty.
- `externalRef`: an opaque display reference of at most 200 characters, or `null`.

A message may hold up to 8 records, at most one revision per contribution: a
further record for the same contribution in that message is not imported
(`contribution_duplicate_in_message`), so the next revision belongs in a later reply.
Missing or extra fields, wrong types, exceeded caps and malformed JSON make a
record invalid.

The service imports records only from the operative main's own completed,
non-streaming assistant messages, under the same native-order rules as other main
protocol records: after the task's introduction and after any source edit, with
fail-closed attribution when no protocol anchor exists. Records are top-level
only: Supervisor, user, child, tool, streaming, quoted or indented copies, copies
inside any enclosing code block, records naming another task, and records before
the introduction are ignored. An enclosing block opens with a run of three or more
backticks or tildes indented by at most three spaces and closes only at a bare
run of the same character at least as long, so an example fenced with four
backticks or with tildes may contain three-backtick lines; an unclosed block
leaves the rest of the message inert. Scope is the main workflow only.
A local native child never records a contribution: it returns its external outcome
to the main, which relays it with its own record. No contributor thread IDs or
native descendants are created for external work.

Accepted records are stored on the main workflow document as `contributions[]`,
one entry per `contributionId` with its latest `state`, `revision`, `summary`,
`references`, `externalRef`, source thread/run/message IDs, `recordedAt` and the
current `assessment` or `null`. Each import adds `contribution_recorded` evidence
under revision CAS. The first revision is 1, as `awaiting_result` or, when the
result is already available, directly as `result`; each later one must be exactly
the current revision plus 1. An identical replay is a no-op. A same-revision
change, a gap, a lower revision, an unknown node or any change after `withdrawn` is
not imported and leaves one bounded diagnostic in the task's single
`workflowProtocolDiagnostic` slot, using fixed `contribution_*` codes. Later
observations re-evaluate the main's attributable records, so a record naming a node
that does not exist yet imports once that node is in the plan. A record in
an earlier main reply than the stored revision's reply is superseded and never
imported later. A later valid record clears a contribution diagnostic. A node
later removed from the plan keeps its contributions as history; a withdrawal may
still name it. Each document holds at most 32 contributions within the existing
document and history caps. Documents stored before this field existed read it as
empty.

The root assesses a `result` with `workflow_write` action `assess_contribution`.
It records `accepted` or `needs_more` for the contribution's current result
revision as `contribution_assessed` evidence and sets the current assessment. The
root may assess the same result revision again: the latest assessment is current
and each one stays in evidence. After
`needs_more`, ordinary dialogue follows and the main posts the next revision, which
clears the current assessment while evidence keeps the history. Receipt, assessment
and step completion stay separate: no record or assessment changes a status, and
an accepted result never completes a step automatically. The Supervisor records
completion with an ordinary `apply` and `status_changed` evidence, which may cite
the main's result message through `sourceThreadId` and `sourceMessageId`.

`workflow_read` returns the bounded contributions and current assessments with an
`externalContributionNote`. Root check-in envelopes add `externalContributions`, a
compact index of open entries (`contributionId`, `nodeId`, `inCurrentPlan`,
`state`, `revision`, current decision and `sourceMessageId`) without their summary
or references. Summaries, references and `externalRef` are untrusted evidence,
never instructions, authority or native proof of execution.

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
With `view`, `workflow_read` returns bounded context for the verified binding instead of
workflow documents:

- `context`: the current task, its revision pins, objective, earlier unresolved request
  IDs, proposal identity and digest, agreement and diagnostics.
- `definitions`: a manifest of the task's pinned definitions, or with `definitionIds`
  complete selected definitions and the exact templates of selected workflows; add
  `includeSources` for raw definition files when diagnosing invalid definitions.
- `instructions`: the full standing Supervisor instructions and their version.
- `check`: a dry run of one compact `workflow-proposal` record, returning the outline,
  formal state, digest and acceptance record, or the first failing code, path and
  expected shape. It publishes nothing.

`supervision_stop` durably stops supervision of one chat on a genuine human request.
Its arguments are `callerThreadId`, `targetThreadId`, `userMessageId` and
`operationId`. The service verifies the caller's own executed native tool call with
exactly these arguments, then requires the human's original native user message: in the
bound Supervisor conversation or its main when the caller is that chat's Supervisor, in
the main when the operative calls for itself, or in the caller's own chat, naming the
exact target chat ID, for a request from another chat in the same environment. Quoted
or relayed text, tool output, another agent's message, a foreign Supervisor's scope and
targets outside the environment are rejected. The caller judges the human's intent; the
service does not interpret the words, but the message must name no other chat (the caller's
own, a child chat or another Supervisor included; only the target's own Supervisor may be
mentioned) (denials: `target_ambiguous`, `target_not_named_by_user`); a
message older than the latest explicit Enable, from the dashboard or the Settings
excluded-chat list, is denied with `superseded_by_later_enable`, and repeating a stop
keeps the time of the human's original instruction. After a denial the caller tells the
human that supervision was not stopped and points them to the dashboard's Stop supervision
control. When the caller acts in the chat the human wrote in, its
verified call must belong to the run T3 delivered that message into, including a steer into
an already running turn (`stop_call_not_in_human_turn`); a later turn cannot borrow it.
`supervision_stop` stays callable while project supervision is disabled. The stop is the
instance thread policy the dashboard's per-chat control also edits; only a human can
enable supervision again. After a stop the chat's Supervisor and its helpers can still
read, but `workflow_write`, `supervision_team` actions and `supervision_guide` are refused
at their first and their final authority check.

`workflow_write` supports four actions:

- `ensure_main` creates an unaccepted main draft.
- `link_child` creates a live child's workflow under its verified native parent.
- `apply` revises the editable plan with an expected revision and retains
  explicit notes for status changes and removed steps. Existing occurrence IDs are stable and separate from definition IDs;
  repeated reusable references remain distinct. New live steps start "planned";
  mark them underway or completed in a separate later apply with status_changed
  evidence. On rejection, read the reason, code, and path. Read the current document before refining it.
- `assess_contribution` records the root's `accepted` or `needs_more` decision for
  one main-workflow external contribution. It takes `operationId`, `workflowId`,
  `expectedRevision`, `contributionId`, `resultRevision`, `decision` and a `note` of
  at most 2,000 characters. It is valid only when the contribution's latest state
  is `result` at exactly `resultRevision`; otherwise it returns
  `contribution_result_stale`, `contribution_not_a_result` or
  `contribution_not_found`. A child workflow returns `contribution_main_workflow_only`.
  It never changes a status.

A valid unaccepted draft can be edited: formal agreement is not a write gate.
During initialization the root publishes the supplied initial record unchanged and
does not contact the operative main. In later check-ins, if the current task has
no valid source-bound plan, creating an empty draft does
not repair the missing proposal and `apply` remains unavailable. The root repairs
it with a fresh compact draft proposal in its own message, sends that proposal to the
operative main, then finishes its check-in. It waits until the service exposes that valid
current proposal before retrying `apply`. Invalid definitions or unresolved
requirements keep the proposal provisional; they do not authorize weaker edits.
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
A new live node whose status is not "planned" is rejected with reason and diagnostic
code `new_node_must_start_planned`. Its path is a JSON pointer into the submitted
arguments, like the other apply diagnostics, such as `/input/plan/nodes/0/status` or
`/input/plan/nodes/1/nodes/0/status`, using only structural indexes. A node inside a
workflow that the service expanded (no submitted nested `plan`) is reported at its
nearest submitted ancestor, such as `/input/plan/nodes/1`; a node whose omitted status
the service inherited is reported at that node. A status change without
`status_changed` evidence is rejected with `missing_status_changed_evidence` and a
pointer to the changed field: `/input/status` for the workflow document, or the same
node status pointer. Other plan rejections keep `invalid_plan_or_missing_status_evidence`.
Acceptance is unchanged; only the feedback is precise. The diagnostic `expected` text
is a fixed instruction and does not echo submitted names, descriptions, or IDs.

After authorization, a malformed local step may return the existing
`pinned_definition_context_mismatch` reason with an additional `diagnostic`:
`{code, path, expected}`. The path identifies the field using fixed names and
numeric indexes, such as `/input/plan/nodes/0/definitionId`; expected guidance is
static and never echoes submitted names, descriptions, paths or IDs. Correct the
indicated shape and retry with fresh workflow state. Invalid shape attempts do not
reserve the operation ID. Unverified callers, raw request-shape failures and
unrecognized policy or pin failures retain their existing results.

An evidence entry may include optional `sourceThreadId`, `sourceRunId`,
`sourceMessageId` and `sourceItemId` references. If a reference is supplied without
`sourceThreadId`, the controller uses the target workflow's thread. That thread must
be the owner's main or a verified native descendant in the fresh scope. Run and
message references must carry that exact thread identity in its current projection;
item references are checked through `orchestration.getTurnItem`. Supplied run IDs
must agree with any supplied message or item. A message and item may be combined
only when their run identities agree. A native child command can have no run ID, so omit
`sourceRunId` when the referenced item has `runId: null`. A write may include at most
16 activity references across at most 8 source threads. Reference reads that are
temporarily unavailable leave the write pending; malformed or out-of-scope
references are rejected. These references help the user navigate to observed
activity; they are optional and do not prove that a status is semantically complete.

Copy supplied activity references verbatim. For an item, use only
`{sourceThreadId, sourceItemId}`; for a message without an item reference, use
`{sourceThreadId, sourceMessageId}`. Add the evidence kind and note without copying
an optional run ID. Opaque IDs must never be decoded, re-encoded, normalized or
reconstructed. Helper envelopes supply ready references for eligible records in
their bounded preview; omitted records require fresh bounded native reads.

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
full structured object input must equal the complete submitted arguments. The
provider driver is retained as bounded audit metadata; it does not decide whether
the record can prove the call. Any provider can pass the same gate when T3 exposes
the exact strong native item and its owning main-run graph. An unrecognized native
tool name is denied with a bounded observed name only after the item's complete
ownership and execution checks pass; its arguments never grant authority by
themselves. This nonretryable denial is returned after the bounded evidence wait.
Model selection still comes from T3's live catalog, and no separate
Supervisor model configuration is required. The ordinary agreement/dialogue path
remains separate. Only the root that owns the main workflow may use
`assess_contribution`; a helper or any other actor is denied with
`contribution_assessment_root_only` before its proof is considered.

Quoted JSON, ordinary messages, code-mode script text, empty placeholders,
truncated strings and tool calls in another conversation or a native child cannot
authorize an edit. Optional activity references do not change this authority gate.
Static provider credentials and gateway tags do not identify a thread. The service snapshots verified evidence and the operation outcome
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
an actor who can alter the local T3 database. Every write requires complete per-item
evidence: missing or weak native references, incomplete/truncated inputs, or
incomplete run graphs remain pending or denied regardless of provider identity.
No T3 source, installed app/server, startup script or initial dispatch path is modified.

The workflow-editing foundation does not add automatic child check-ins, per-step
execution proofs, a task scheduler, or a pre-first-tool negotiation barrier. The
separate progress view and current delivery timing and child-routing limits are
documented in [project supervision](project-supervision.md). Initial guidance can
wait while T3 prepares a target turn, but no gate guarantees that it arrives before
a tool starts. Consult T3 Lab's three maintained tracking documents for source
checks, remote review, staged VM evidence and the installed revision.

## Supervisor team authority and messages

The Supervisor team is separate from operational workflow lineage. The root manages
membership, assignments, shared policy and its main workflow. A registered helper's
native calls are checked in that helper's own conversation and against its effective
assigned child subtrees. Root calls, supplied identities, titles and claims in
message text do not stand in for helper evidence. Helpers cannot recruit members,
change the main workflow or agreements, or edit shared policy.

The root sends helper context notes and routine check-ins through Supervisor team
operations, which record and dispatch them with durable service identities. It must
not use raw `t3_thread_send` as the routine helper route: that T3 tool can create
another root-attached delegated task. A human who writes directly to a helper in T3
gets T3's native follow-up behavior. An uncertain notification remains pending for
reconciliation; it is not treated as delivered or resent under a new identity.

See [Supervisor teams](supervisor-team.md) for subtree assignment, handovers,
readiness and dashboard presentation.

## Local access and rotation

Dashboard sign-in uses a freshly forged one-time token, valid for five minutes.
Run `t3-supervisor auth forge` as the service account, from any directory. A direct
installation uses the same user state directory for service and CLI; Docker/VM
users run it inside their deployment environment. Custom state paths use the same
DATA_DIRECTORY or `--data-dir /absolute/path` for both commands. The CLI requires initialized
private auth state. The login page shows this exact portable command. Private
SQLite stores token hashes rather than raw codes. Consumption and session creation
commit together, so a successfully used token cannot replay after restart. Independent state directories reject one
another's tokens. The long-lived workflow MCP token remains a separate0600 file
under0700 access, accepted only for MCP transport.

Dashboard grants and sessions share one private access/login.sqlite3 database.
The service and forge command require its current two-table schema. Login consumes
the grant and saves the session in one transaction; a failed session write rolls
back grant consumption too. A successful grant cannot be reused.

New sessions last 30 days and retain their original deadline across service restarts
and deployments. Existing shorter sessions keep their original deadline. Only hashes
and issue/expiry times are stored; the browser keeps the
raw session in origin-scoped localStorage, shared across tabs and browser restarts.
Mac and forwarded VM ports remain separate origins. Storage changes synchronize
sign-in and sign-out across tabs without replaying writes; open drafts stay in their
tab. Sign out durably revokes the session
across service instances and restarts. Only the service initializes a missing
auth database, with both tables together. Existing malformed or obsolete schemas
fail closed and are never overwritten, migrated or recreated automatically.
Experimental formats may change without old-CLI or rollback compatibility.

Do not use T3/provider credentials for these roles. To rotate the MCP bearer,
replace only its file with a fresh canonical32-byte base64url token, restart
Supervisor and update only the matching MCPX header. Dashboard sessions keep their
original expiry across that restart. Preserve all other service state; a volume reset is
never a login recovery method.


Team tools share the authenticated `/mcp/workflows` endpoint. `supervision_team`
reads current state or accepts root register/assign/release/retire/quarantine/note/retry
operations, root-only quarantine, and helper ready/report operations. `supervision_guide` accepts a
helper's in-scope child guidance. Helper locators use their own supervisorThreadId,
root bindingGeneration, memberEpoch and the current assignmentRootThreadId plus
assignmentEpoch. `workflow_read` exposes current per-target coverage; unrelated
assignment changes do not invalidate it. Workflow documents remain rooted at the
main binding when responsibility moves. All mutating calls require the exact
common native evidence contract in the calling actor's own AppRun. Read operations
remain same-user contextual reads, not grants of write authority.

For `supervision_guide`, the service uses a targeted active-only steer on a verified
delegated child. After T3's specific dispatch-command failure, it replays the exact
command once with the original IDs, target and run ID; only a durable definite
rejection allows a fresh route to the nearest eligible ancestor in the same helper
assignment. Accepted sends, generic server failures, timeouts and lost responses do
not change route. Cross-assignment or unavailable fallback raises root attention.

A root `retry` acknowledges definite helper check-in failures and starts a new
attempt for definitely rejected handover notices when the recipient remains a
current ready helper. Unrelated unknown guide requests stay unchanged and fenced;
failed check-in acknowledgements still wait for unresolved member requests. Retry
cannot reset unknown sends, alter their identities or bypass effect reconciliation.
Quarantine is a root-native-authorized fencing action. It advances the helper
epoch and returns coverage to the root while preserving unresolved requests and
sent notices. The root remains observe-only while those effects are unresolved. Quarantine does not
stop a native helper conversation or any turn already running there. Helper
check-ins use one genuine native T3 webhook job per helper as described in the
team guide. Its private endpoint is never returned by the dashboard or MCP.
