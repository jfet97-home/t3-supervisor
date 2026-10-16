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

An assignment is monitoring responsibility. It does not change a workflow's
operational owner, a step's ownership or a contributor-thread association. Child
completion does not complete a parent step. Work without an effective helper
assignment remains the root's responsibility. Team membership and operational
workflow lineage are separate trees.

Helpers inherit the root's model by default. The root may select another model
from T3's current configured catalog for a helper. T3 remains responsible for
native model selection; the Supervisor does not maintain a separate model catalog.

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
only a handover notice that is still pending and has never been sent may be superseded.
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
A definite failed check-in or handover notification requires the root's explicit
`retry` team action or reassignment. The retry action only starts a new attempt for
known definite notification failures for a current ready helper without clearing
unrelated unknown effects. Failed check-in acknowledgements wait for unresolved
member requests. An uncertain notice or request keeps its original identity and
remains fenced.

## Helper guidance

`supervision_guide` accepts guidance only from a ready helper in its current
assigned subtree. The service checks fresh native scope, lineage, runtime
questions, active provider turns and contactability.
A pending owner question or approval on the target defers intervention; it does not
cause guidance to be sent to an ancestor around that pending decision. Fresh
resolved/expired/cancelled request state takes precedence over a matching stale
waiting hint, while unavailable or mismatched evidence remains conservative. Direct guidance to a delegated
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
