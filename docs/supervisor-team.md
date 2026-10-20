# Supervisor teams

Each ordinary main conversation has one Supervisor root. The root may recruit
direct T3 child conversations as helpers when parallel monitoring would reduce its
workload or context pressure. The team is flat: helpers do not recruit helpers.
One helper may cover several operational child subtrees; a separate helper for
every child is not required.

## Responsibility and scope

The root coordinates the operational main, team membership, shared policy and
unassigned work. A helper assesses and guides the operational subtrees assigned to
it, including verified descendants added later. Helpers may update child workflows
inside their current scope. They cannot change the main workflow or agreements,
edit shared policy, recruit helpers or grant authority.

For workflow link and apply, a target is eligible when it is unarchived, undeleted
and currently assigned to the helper. Its T3 run may be idle or finished; this is
separate from the steerable active-run requirement for `supervision_guide`.
Normal monitor envelopes carry complete `workflow_read` and link arguments plus
locator bases for apply, guide and report. An entry's `input` is the complete MCP
argument object; pass it as the arguments without nesting it again. The
`workflow_write_link_child` envelope label is not a tool name: pass its `input` to
`workflow_write`, with top-level `childThreadId`.
`workflow_read` has no `targetThreadId`; guide and report do use `targetThreadId`.
The direct aliases are `t3-supervisor-workflows.workflow_read` /
`mcp__t3-supervisor-workflows__workflow_read`, `t3-supervisor-workflows.workflow_write` /
`mcp__t3-supervisor-workflows__workflow_write`,
`t3-supervisor-workflows.supervision_guide` /
`mcp__t3-supervisor-workflows__supervision_guide`, and
`t3-supervisor-workflows.supervision_team` /
`mcp__t3-supervisor-workflows__supervision_team`. For MCPX, call
`mcpx.mcpx_call_tool` or `mcp__mcpx__mcpx_call_tool` with only `{name, arguments}`;
`name` is the MCPX target `t3-supervisor-workflows__workflow_write` and `arguments`
is the complete schema object. That target name is not a direct alias. Use
advertised harnesses such as `functions.exec` normally to discover and invoke
actual MCP tools when needed; the outer harness or source text is not proof. Only
the resulting verified native MCP tool identity and complete arguments count, and
never claim or fabricate a tool call.

Apply has `action` and authority locators at the top level, with mutation fields
nested under `input`: `{action:"apply", ...locatorBases.workflow_write_apply,
input:{operationId, workflowId, expectedRevision, note, plan}}`. The `workflowId`
and `expectedRevision` come from a fresh child read, and `note` is required. Omit
`sourceBinding`, `requirements` and `issues` so the service supplies trusted context.
For a new local step, use this structural shape inside the plan and choose task-specific content: `{kind:'sequence',nodes:[{kind:'step',definitionId:null,localId:'local-check',name:'Check child result',description:'...',reason:'...',status:'planned'}]}`. Omit `nodeId` so the service allocates it, and preserve actual returned `nodeId` values in later edits. For new local steps, omit `templatePath` and never copy a parent's `templatePath` into another child plan; this does not apply to genuine named-workflow expansion.
Guide and report need fresh action-specific content, so their locator bases are not
callable payloads. Each new mutation gets a unique operation ID; reuse one only to
retry the exact same arguments after an uncertain result.

Each target's `activityRefs` provides ready-to-use item-only or message-only
references for eligible activity in that target's preview. Copy the supplied pair
verbatim when adding an evidence kind and note; omit `sourceRunId` and never
normalize encoded IDs. Synthetic keys and absent or oversized IDs do not gain an
invented reference. Read additional records with bounded native pagination and
use their exact returned IDs. References remain optional navigation evidence;
they do not establish completion or authorize a workflow write.

Each helper review is sized against the serialized prompt. It may include only a
subset of assigned targets; its counts and trigger cover that subset, and completion
acknowledges only the included monitor versions and notifications. Fitting targets
left out by the size bound remain pending for a later review. If a target cannot fit
even in a one-target review, the root receives a stable attention event and its
monitor activity remains pending.

When an eligible assigned child has no workflow document, its helper may use the
supplied `link_child` input for that exact child. It includes the helper's own
`supervisorThreadId`, `bindingGeneration`, `memberEpoch`, `assignmentRootThreadId`,
`assignmentEpoch`, operation ID and note. Linking creates a separate child document
beneath the verified immediate parent and does not modify the parent's workflow,
including the main. The helper then reads and updates only that child document. If
the immediate parent document is missing or coverage is inactive, transferring,
unavailable or uncertain, the helper escalates to the root; it does not create a
parent workflow or rely on automatic child creation. A not-found read alone does
not prove unavailable coverage: verify the target and current epochs against fresh
lineage/coverage. Notifications carry a read-only `workflow_read` input; their
assignment values do not authorize writes. Writes, guidance and reports wait for a
normal monitor envelope that confirms current coverage. A missing target thread is
marked unavailable and must also be escalated.

When applying a child plan, omit `sourceBinding`, `requirements` and `issues`; the
service supplies trusted task and definition context. New plan occurrences start
`planned`, even when the work described already finished. Record completion in a
separate apply only after fresh child evidence and an explicit evidence note, using
the current child `workflowId` and revision.

An assignment is monitoring responsibility. It does not change a workflow's
operational owner, a step's ownership or a contributor-thread association. Child
completion does not complete a parent step. Work without an effective helper
assignment remains the root's responsibility. Team membership and operational
workflow lineage are separate trees.

Helpers inherit the root's model by default. The root may select another model
from T3's current configured catalog for a helper. T3 remains responsible for
native model selection; the Supervisor does not maintain a separate model catalog.

### Temporary provider-session isolation

Until the installed T3 build contains the parent-detach correction in upstream
PR #20361, an installation can set `SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID` to a
second configured native provider instance. New helpers must use that instance;
the root defaults to its current native model and explicit options, with compatible
deliberate overrides still allowed. Registration requires a different root instance
and nonempty, disjoint native sessions belonging to the exact root/helper threads.
Unavailable or unverifiable isolation blocks recruitment and raises root attention.
Existing helpers are not moved. Unset configuration retains normal recruitment.

This is a temporary installation workaround. The Lab's
`supervisor-provider-isolation-workaround-2026-10-16.md` records configuration,
verification and removal after the fixed published build is actually installed.

The default maximum is five helpers per root. Project settings accept an integer
from zero to twenty. Zero disables new recruitment, and lowering the limit does
not delete existing members or their history.

## Registration and handovers

A helper is a real T3-delegated child, registered to its root after its identity
and bounded readiness check are confirmed. A completed bootstrap does not retire
the membership. Monitoring assignments remain active across finite later helper
turns. Failed, stopped or uncertain turns do not silently create a replacement.

Reassignment informs both affected helpers and records the handover state. The old
helper stops new guidance for the transferred subtree while existing effects are
settled or reconciled. New coverage becomes active only after the transfer is
confirmed. Pending or uncertain notifications remain visible, and the root remains
responsible while ownership is unresolved. An old helper may keep working on its
remaining assignments or become idle for reuse.

## Quarantine and recovery

When the root must revoke a helper's service authority before normal handover can
finish, it may use the root-only `supervision_team` action `quarantine` with fresh
native caller proof. Quarantine advances the helper epoch and returns its assigned
coverage to active root ownership, but keeps the root observe-only for affected
work while unresolved writes or delivery effects remain. It preserves every
unresolved request and every sending, sent, uncertain or delivered notification;
only a handover notice of the ended transfer epoch that was never sent (pending) or
was definitively rejected (failed) is superseded, keeping its attempt and failure
reason. Observing a quarantined helper's remaining notices never marks it missing,
and neither does a helper read that was already in flight when the root quarantined it.
Eligibility is re-read after every await and immediately before a POST, so nothing is
posted after quarantine; an attempted notice with no delivery receipt was never posted
and, once its recipient is no longer eligible, fails as definitely undelivered. A
check-in or readiness delivery whose authority ends before its POST likewise fails as
never posted and settles only its own request fence, in one transaction. After a
restart, a quarantined helper's check-in or readiness request without a delivery
receipt is recognised the same way; anything with a receipt keeps its fence.
These notices remain visible until acknowledged or otherwise reconciled. A known
definite notification failure can be retried by the root when its recipient is
still a current ready helper; unrelated unknown guide effects remain fenced. An
uncertain delivery cannot be retried. Quarantine revokes Supervisor authority; it does not stop, cancel,
archive or delete the
helper's native T3 conversation or any turn already running there. Retiring the
helper is a separate action and also does not claim to stop its T3 conversation.

## Native check-in delivery

Each registered helper has one genuine T3 webhook task bound to its existing child
conversation. It is event-triggered by Supervisor when there is work, with no timer.
The service obtains the environment-relative webhook endpoint from T3 and uses the
existing T3 connection directly. T3 Connect and extra proxy services are unnecessary.
The endpoint token stays private. The native job appears in T3's scheduler; pausing,
deleting or retargeting it stops delivery rather than silently overriding that choice.
Native model/mode changes are reflected in the owned job before the next delivery.
Retirement deletes only the matching owned job and retains Supervisor history.

The scheduler supplies the actual scheduledTaskId, so routine turns do not add
follow-up task records or completion wakes to the root. Direct WebSocket or MCP
helper messages have different T3 semantics. Webhook POSTs have no client idempotency
key: an uncertain send is never posted again; the service reconciles its original
scheduled-message identity and request text, retaining unresolved work meanwhile.
Once an attempt has a delivery receipt, its exact sent bytes identify it for matching,
acknowledgement, review and reconciliation; regenerated text, for example after a role
wording change, applies only to an attempt that was never posted. A durable or native
rejection of an attempted POST is reconciled read-only even when the helper can no
longer be read, so it cannot strand a definitely undelivered notice.
A notice or check-in is `failed` only when T3 definitively rejected that exact POST or
nothing was ever posted for its identity. A later refusal (helper unavailable, binding
replaced, changed content) of an identity whose earlier POST has an unknown outcome
keeps it uncertain and fenced. A definite failed check-in or handover notification requires the root's explicit
`retry` team action or reassignment. The retry action only starts a new attempt for
known definite notification failures for a current ready helper without clearing
unrelated unknown effects. Failed check-in acknowledgements wait for unresolved
member requests. An uncertain notice or request keeps its original identity and
remains fenced. A delivered notice whose native run ended interrupted, failed,
cancelled or rolled_back without its completion marker stays delivered and fenced.
The team view shows that run status, a bounded attention item points to
`review_handover`, reassignment or quarantine, and the root keeps responsibility.

The root-only `supervision_team` action `review_handover` creates a finite effect
review through the existing notice transport. It requires the same exact native
root caller proof as other root mutations, `operationId` (at most 128 characters),
`notificationId`, `expectedDeliveryAttempt`, `expectedRunId`, and `expectedChain`.
The notification identity always names the original `handover_release` or
`handover_receive`, never a review. The optional `note` is nonempty plain text of
at most 1000 characters (no control characters except tab/newline/CR), included as
untrusted root context. Errors are fixed codes and do not echo inputs. Replaying an
operation ID with identical input returns its stored response; different input
conflicts.

The chain root is the original notification at its exact delivery attempt.
`expectedChain` is an ordered list of `{notificationId, deliveryAttempt, runId}`:
the original if still delivered and unresolved, then every prior delivered,
unclosed review of that original whose run ended without completion, in creation
order. It must contain the entire open set, with no duplicates (at most 64
entries). Each review durably records immutable `reviewOf` (the original ID,
attempt and observed run ID) and `reviewChain` (that exact open set). An interrupted
review therefore participates in the next review, rather than being abandoned or
silently retried. An already acknowledged original is omitted from the open set;
its interrupted, sent reviews can still require another review.

Before creating anything, the action reads the helper's current native projection.
Every chain member's exact transport message must be visible, its recorded run
must exist with the same terminal interrupted/failed/cancelled/rolled_back status,
and no run of that message may be running, completed or have a completed final
assistant marker. Native completion refuses the action so normal reconciliation
can acknowledge it. Missing or changed evidence refuses without a review mutation.
The store then atomically rechecks the entire chain, original attempt/run, ready
member epoch and transferring assignment epoch. Pending, sending, uncertain or
still-running reviews block another review. A definite failed review requires
`retry`, which only retries while its exact chain remains open. An uncertain
review POST is never repeated and blocks later reviews until native reconciliation
finds the original message. All chain state and receipts survive restart.

The review asks the helper to inspect actual native effects of **every** listed
attempt, including earlier reviews, perform only genuinely missing duties within
current authority, and state which effects remain unresolved. It must never
replay an operational instruction or infer non-execution from interruption. Its
own exact native completed run and final marker acknowledge only that review.
At that point the service repeats the creation-time native check on the current
projection: a chain attempt whose message now has a running, missing or
marker-completed run is not closed by the review and keeps its fence; a
marker-completed attempt is acknowledged through its own completed run.
Native evidence for an attempt is every copy of its exact receipt message and every run
strongly linked to one, by its userMessageId or by the message's own runId; any live
or unknown-status run keeps the attempt open, and a marker completion is only used
once every linked run is terminal.
Generic monitor check-in markers and helper/tool acknowledgement claims cannot
acknowledge a handover or review.
For each still-unresolved chain member in the same current assignment and member
epoch, the service adds `resolvedByReview: {reviewNotificationId, reviewRunId,
resolvedAt}`. Those members remain `delivered`, retaining IDs, message bytes and
`observedRun`; none is relabelled acknowledged or resent. Closure is notice
bookkeeping, not proof that external effects did not happen.

A late native completion of the original can still acknowledge its actual proven
run, preserving historical interruption evidence. A review that was never posted
(pending) or was definitively rejected (failed) cannot have native effects. It is
superseded, keeping its attempt and failure reason, once an exact attempt in its own
frozen chain closes or its transfer epoch ends, including when a definite rejection
arrives after that closure. No review can be created while such a review exists, so
its open set only shrinks; an attempt that was already closed gaining its own
acknowledgement changes nothing. The root can then review the remaining open set.
Sending, uncertain or delivered reviews remain independent fences until their own
completion or a later review closes them, without double resolution. A posted review
is never sent again: its receipt is reconciled read-only, so durable or native
rejection evidence still fails it after a restart. Ending a transfer epoch through
missing or quarantine handling likewise supersedes that epoch's pending and
definitively failed notices, never sent or uncertain ones; a sent review completing
after an epoch change acknowledges itself but cannot close the stale original. Reassignment
or release cannot bypass an ongoing transfer; revoking a helper through missing or
quarantine handling advances the epoch before a new assignment can be made.

Neither a handover/review acknowledgement nor review closure settles any
`TeamRequest`. Transfer completion still waits for every captured affected-subtree
request (including older or inherited assignments), every request of the exact
transfer assignment epoch, and every handover/review notice of that epoch to be
acknowledged, superseded or closed. Unrelated inherited sibling requests are not
swept into that transfer. Concrete request and guidance-effect reconciliation
remains independent and may require manual inspection.

## Helper guidance

`supervision_guide` accepts guidance only from a ready helper in its current
assigned subtree. The service checks fresh native scope, lineage, runtime
questions, active provider turns and contactability.
A pending owner question or approval on the target defers intervention; it does not
cause guidance to be sent to an ancestor around that pending decision. Fresh
resolved/expired/cancelled request state takes precedence over a matching stale
waiting hint, while unavailable or mismatched evidence remains conservative.
An unresolved fallback held by owner input is shown as deferred for an owner
decision. After the existing bounded grace it raises one root-attention event;
fresh resolution resumes the same operation's guarded route checks. Direct guidance to a delegated
child uses targeted active-only steer. If T3 returns the specific dispatch command
failure, the service replays that exact command once with the same command ID,
message ID, target and run ID to read T3's durable result. It changes route only
after T3 confirms a definite rejection. The nearest eligible contactable ancestor
is freshly checked and must still be inside the same assignment; a cross-assignment
or unavailable fallback raises root attention.

An accepted send, generic server failure, timeout or lost response keeps its
original target and identities. The service does not infer rejection from an
uncertain result and does not switch routes. Unresolved guidance is visible as
waiting for confirmation and raises bounded root attention. If the steer reaches
a later child run, the late-wake event is retained for root attention.

## Dashboard and messages

The Projects view has a Supervisor-team section separate from operational
conversations. It shows the root and direct helpers, T3 links, known models,
readiness and lifecycle, assignments, current state, recent assessment, pending
handovers and significant issues. Each operational conversation row shows its
effective assignee. Explicit root ownership, an active helper, a transfer in
progress and an unknown owner have separate labels; missing data is not presented
as root ownership.

The team view is an observation with a timestamp. Incomplete or unavailable data
and refresh failures remain visible; retained data after a failed refresh is stale.
Progress pagination remains scoped to the selected main. Dashboard authentication
is unchanged, and reading team or workflow progress does not wake a conversation or
change workflow state. Observe-only rows accompany otherwise due root work or a
new meaningful root event; they do not repeatedly wake the root on their own.
Their activity stays pending for the eventual owner.

A person who writes in a helper conversation follows T3's native follow-up
semantics. The root sends routine context notes and check-ins through the
Supervisor's team operations. It does not use raw `t3_thread_send` for helper
check-ins, because that route can create another root-attached delegated task.

## Frequently asked questions

**Does an assignment make a helper the owner of the operational task?**
No. It assigns monitoring and guidance responsibility for an operational subtree.
Task identity, step ownership and contributor links remain separate.

**Can a helper supervise another helper?**
No. The team has one root and its direct helpers. Operational nesting does not add
another Supervisor layer.

**Does the team view prove that a helper completed work?**
No. Readiness, lifecycle, assessments and workflow status are observations. They
are not independent execution evidence.

**What if a helper stops or a transfer is uncertain?**
The assignment and pending notification remain visible. Unknown outcomes are
reconciled using their original identities; they are not treated as successful or
replayed under new identities. The root retains responsibility until coverage is
confirmed.

**What if a helper must lose authority while effects remain unresolved?**
The root may use the native-proof `quarantine` team action. Coverage returns to
the root, but unresolved writes and notices stay fenced and visible. This does not
stop the helper's T3 conversation or any turn already in progress.

Source behavior, staged acceptance and live deployment are separate evidence.
Consult the Lab tracking records before making claims about an installed revision
or an actual helper pilot.
