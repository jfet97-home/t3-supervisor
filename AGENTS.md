## Skill ownership

Keep `skills/` focused on portable product usage. Personal installation policies,
source maintenance and deployment procedures belong in the global `t3-supervisor`
skill outside this repository. The Git-backed `use-t3-supervisor` skill is exposed
globally through Skillshare; it must not depend on personal maintenance files.

Skill/documentation-only batches use Git and Skillshare propagation; they do not
require rebuilding or restarting the application.

## Development discipline

- Define the requested behavior and a small set of observable acceptance cases before
  editing. Keep one owner and one findings ledger; distinguish blockers from optional
  ideas. Fix demonstrated failures in the existing path. Remove superseded code and
  instructions instead of layering workarounds, stores, parsers or compatibility on them.
- Test the riskiest user journey early on the VM, before a long implementation or
  review campaign. For negotiation and flooding, inspect actual rendered prompts,
  total traffic, repeated messages, tool arguments and native event timestamps.
  Permissive size ceilings and hundreds of passing unit tests do not prove these
  behaviors. Exercise the real controller/transport boundary under test rather than
  mocking it away. Include a trivial no-contact case and relevant failure/race cases.
- Use an uncoached operative request for live proof. Do not seed agreement, delay the
  operative, or teach the test agent the expected protocol to manufacture success.
  Record the first edit, introduction and completed acceptance separately. Report
  advisory timing honestly; unmodified T3 provides no pre-first-tool barrier.
- When iterative review is requested, retain one ordinary conversation per reviewer
  through supported, authorized APIs and reuse it for later rounds of the same work.
  Pass the exact revision, delta, evidence and unresolved objections. A delegated
  task's backing child thread is not a resumable ordinary reviewer conversation.
  Replace reviewers only for a material scope/context change, explaining why.
- When review is requested, review a frozen candidate and assign one primary reviewer
  per risky scope. Give additional reviewers distinct concerns unless the user requests
  broader coverage. Recheck a fix with the reviewer who raised the finding; involve
  another reviewer only when the delta changes a boundary they reviewed. Include the
  exact delta and relevant callers, plus real message output where messages changed.
  Unrelated fixes do not require every reviewer to approve again. Do not restart
  broad reviews or full campaigns for every small delta. Track every requested
  review to a terminal result. Approval is an assessment, not proof that a
  behavioral acceptance case passed.
- Discover the exact local/native tool and schema before live calls; a remote tool
  with the same name may address another environment. Preserve unknown effect IDs
  and reconcile them; Retry must not turn an unknown send into a fresh send.
- Keep updates and maintained instructions concise. Give evidence-based estimates;
  when a blocker invalidates an ETA, say so promptly rather than rolling it forward.

## Effect v4 throughout

The application, CLI, tooling and tests use Effect v4 at one exactly pinned version for
`effect` and every `@effect/*` package. Write services as `Context.Service` with Layers,
decode untrusted input and stored rows with `Schema`, persist through `effect/sql`, keep UI
async state in Atom/AtomHttpApi, and test with `@effect/vitest` (`TestClock` for timing,
`it.live` for real I/O). Do not call `Effect.run*` in business code or add Promise polling,
ad hoc timers or hand-rolled async state machines. Never log raw causes, tokens or native
bodies. Third-party, native and browser integrations stay small scoped adapters with a
recorded reason; pure calculations, types and JSX stay plain.

## Knowledge Base

This project has an LLM-maintained knowledge base in `knowledge/` (git-ignored). Invoke `$knowledge` or `/knowledge` with the same subcommands and arguments.

- When a local knowledge base exists, consult `knowledge/INDEX.md` and relevant pages before reading code. Use `rg` for exact lookup and `qmd query` when available for semantic lookup.
- After meaningful development or pulling commits, use `$knowledge update`.
- Library lookup order: `knowledge/dependencies/`, installed `node_modules/`, then official upstream documentation. Dependency reference sources are read-only and must never be imported.

## Batch completion and deployment

After completing an implementation batch, deploy the completed Supervisor to both
the Mac and T3 Lab VM and activate any associated MCP/MCPX connection changes.
Source checks alone do not complete a batch. Carry out the normal commit/source
synchronization and deployment steps without asking for confirmation again, unless
the current user explicitly limits deployment or a concrete blocker prevents it.
Verify the running revision, relevant health and a bounded real MCP call; preserve
state volumes, credentials, existing thread identities and instance settings.
Update the Lab's current-state, next-steps and progress documents with the outcome.
Choose checks proportionate to the change; do not replay the entire historical
foundation test campaign. Never modify T3 source or its installed app/server.

## Standing rule: no Supervisor proxy workarounds

Do not add or retain extra HTTP proxies, reverse proxies or relay sidecars to make
Supervisor integrations work. Fix endpoint exposure, authentication, accepted hosts
and client configuration in Supervisor itself. MCPX must connect directly to the
Supervisor MCP endpoint. The existing MCPX gateway remains the client connection;
do not introduce another intermediary. The two legacy workflow HTTP proxy services were
removed by the completed direct-authentication batch. Never modify
T3 source or its installed app/server as a workaround.


## Current phase: rapid development, no backward compatibility

This is an experimental project being iterated quickly on the Mac and Lab VM.
Backward compatibility with previous prototype versions, schemas, file formats,
CLI behavior or configuration is not a requirement unless the user explicitly
requests it for a particular change. Prefer the simplest current implementation.
Do not add compatibility layers, legacy fallbacks, duplicate databases/stores or
migration frameworks solely to keep obsolete experimental versions working.
The former split grant/session databases are the concrete example to avoid.
Obsolete prototype code and tests may be replaced rather than carried forward.

Preserving current credentials, active sessions and non-disposable user data is
operational care, not a reason to retain old product formats. When necessary,
use a bounded one-off operational cut-over rather than permanent compatibility
machinery. This policy does not authorize unrelated data resets.
