# Effect v4 migration plan

Status: **plan v2.2 (pins: exact 4.0.6, UPGRADE-406)**, a narrow follow-up to frozen v2.1 `d986e7ee` (after v2 `059e4a82` and
v1 `14b4a875`). It closes the run-4 findings only: the native in-flight lookup, resource
ownership and cancellation owner of 3.11 (SOL-PLAN-02, A-P03), the candidate-free
interpretation cut-over of 3.12 (SOL-ISUB-02) and the consistency notes (RUN4-PREC). All
other decisions are unchanged and reconciled in one ledger (section 13). S0/S1 test-only
work is authorized by the coordinator on unchanged application source and baseline
dependencies; S1b, S1c and every production port wait until both reviewers approve the
full plan and the coordinator confirms alignment. Owner: Opus (sole implementation owner).
Manifest: [`effect-v4-files.json`](effect-v4-files.json) (one row per baseline tracked
file; `planVersion` `v2.2`).

## 1. Baseline

| Item | Value |
| --- | --- |
| Commit | `3b8129aea24518774b7237d666c22739e82af3b6` (`main` == `origin/main`) |
| Branch / worktree | `effect-v4-migration` at `/var/lib/t3/worktrees/t3-supervisor/effect-v4-migration` |
| Tracked files | 159: 55 `src`, 1 `scripts`, 48 `test` (47 suites + 1 fixture), 23 `ui`, 10 `docs`, 4 `skills`, 2 `.impeccable`, 1 CI workflow, 15 root config/docs. Both reviewers verified 159/159 paths and blob IDs. |
| Tests | node:test via `tsx --test`: **869 reported, 869 pass, 0 fail/skip/todo** (owner: Node 24.22.1, 196 s; Astra: 139.9 s). 849 top-level tests = 843 top-level leaves + 6 parent tests; the 6 parents contain 20 subtests and make no direct assertions; 843 + 20 = **863 leaf cases**; 863 + 6 = 869 Node results. Both reviewers verified 863 leaves, 6 groups and 20 children by file, name and source order. |
| Effect today | `effect`/`@effect/platform-node`/`@effect/atom-react` 4.0.1. The process root is already an Effect program: `src/cli.ts:23` imports `src/main.ts`, which runs `NodeRuntime.runMain` over `runSupervisor` (`src/supervisor.ts:68`), which forks `runGuidanceApplication` (`src/guidance-application.ts:22-140`) inside a restart loop. That composition root constructs every Promise/class controller. Business modules are Promise/class based, with 23 `Effect.runPromise` calls (`project-supervisor.ts` 12, `project-definitions.ts` 8, `guidance-application.ts` 2, `guidance.ts` 1), synchronous `node:sqlite` stores, `ws` callbacks and timers. |

The manifest records each file's leaf test names in file order under `testNames` (subtests as
`parent > child`) and the parity arithmetic plus the 6 named groups under `baseline.tests`.

## 2. Effect version decision and provenance

**Target: `effect` 4.0.6 and every Effect companion at exactly 4.0.6 (exact pins, no caret);
Vitest 5.0.5 unchanged.** Upgraded from the reviewed 4.0.5 target by the user's explicit
"use latest v4" decision once the matching 4.0.6 set was published (UPGRADE-406, section
13). Verified on 2026-10-22 at about 19:10 UTC against registry.npmjs.org (coordinator
evidence at 19:08Z, owner recheck): `latest` is 4.0.6 for all seven Effect packages and
5.0.5 for Vitest; every companion declares `effect ^4.0.6`, `@effect/vitest` declares
`vitest >=5.0.0 <6.0.0`.

| Package | Version | npm publish (UTC) | npm integrity (sha512, prefix) | Use |
| --- | --- | --- | --- | --- |
| `effect` | 4.0.6 | 2026-10-22 17:47:13 | `Tc3mkzuLR6t6P9dh…` | core, http, http-api, sql, cli, reactivity, socket, process, testing |
| `@effect/platform-node` | 4.0.6 | 2026-10-22 18:30:12 | `gXvGHAy0/8PZbWvM…` | NodeRuntime, NodeServices, NodeHttpServer, NodeSocket, NodeFileSystem |
| `@effect/platform-node-shared` | 4.0.6 (override) | 2026-10-22 03:23:26 | `0PhyC4uG30xGtsaj…` | transitive (keeps the existing override) |
| `@effect/atom-react` | 4.0.6 | 2026-10-22 03:26:10 | `DpbuEdaJl+2/GW4K…` | React bindings |
| `@effect/sql-sqlite-node` | 4.0.6 | 2026-10-22 03:24:50 | `mYWr1Ppoz3/XrY+Z…` | SqliteClient over `node:sqlite` (added in S3) |
| `@effect/vitest` | 4.0.6 | 2026-10-22 03:25:07 | `oKNbtyUHK5+0o730…` | test harness (peer `vitest >=5 <6`) |
| `@effect/platform-browser` | 4.0.6 | 2026-10-22 03:23:15 | `i4bf1+FlUnZypqK0…` | only if S7 adopts `BrowserKeyValueStore` |
| `vitest` | 5.0.5 | npm `latest` | — | runner required by `@effect/vitest` |

- npm dist-tags for `effect`: `latest` 4.0.6, `staging` 4.0.6, `rc` 4.0.0-rc.118, `beta`
  4.0.0-beta.107, `prev` 3.22.3. Prereleases and v3 are excluded.
- **Transition evidence for 4.0.6 (owner, before any pin is applied):** the unchanged
  `3b8129a` source typechecks (server and UI) and passes the node:test baseline 869/869 on
  the exact 4.0.6 set; the S0 harness self-tests pass on it; the 3.11 admission probe
  (`docs/effect-v4-admission-probe.mjs`) gives results identical to 4.0.5 in all 8 cases.
  The APIs this plan cites exist with the same semantics; source line numbers quoted below
  as `…ts:N` refer to 4.0.5 and shift slightly in 4.0.6 (for example `FiberMap.get` 800,
  the `onlyIfMissing` sentinel 1375, `FiberMap.run`'s fork 1377, `internal/effect.ts`
  `forkUnsafe` 5557; `Semaphore.withPermits` 462 and `Clock.monotonicTimeNanos` 333 are
  unchanged). The one FiberMap change in 4.0.6 also interrupts replaced fibers that are
  still interrupting when the map closes; `get`, `run` and `onlyIfMissing` are unchanged.
  Every other "4.0.5" in this plan means the exact pinned version, now 4.0.6.
- The 4.0.6 fixes that 4.0.5 lacked are now included: atoms keep the latest exposed
  success when an async run fails (#9607); replacing an atom runtime layer through
  registry initial values keeps Reactivity/global layers (#9313); `Effect.callback`
  releases completed suspension state (#9499); `cachedInvalidateWithTTL` (#9617, not
  used). S7 still tests the atom behaviours it relies on.
- The S0 parity step ran on the baseline 4.0.1 and stays as recorded. S1c moves directly
  from 4.0.1 to exactly 4.0.6 and reruns the S1 characterizations and the
  `s1c-transition-golden` outputs unchanged as the transition proof.
- Official guidance used: `MIGRATION.md`, `LLMS.md`, the `migration/*.md` guides and the
  `ai-docs/src` examples shipped with the pinned package. No v3 or beta examples are used;
  v3 shapes (`Context.Tag`, `Effect.Service`, `Either`, `Effect.catchAll`,
  `effect/unstable/*` paths, `@effect/platform`, `@effect/sql`) are banned.

### Module stability and pin policy

`stable` (strict semver): `Effect`, `Layer`, `Context`, `Schema`, `Queue`, `PubSub`,
`Deferred`, `Ref`, `SynchronizedRef`, `Semaphore`, `Latch`, `Schedule`, `Clock`, `Stream`,
`Scope`, `FiberMap`/`FiberSet`/`FiberHandle`, `Config`, `Redacted`, `Data`, `Cause`, `Exit`,
`Duration`, `Option`, `Result`, `Match`, `Logger`, `ManagedRuntime`, `Runtime`.
`unstable` (breaking changes allowed in minors): `effect/http`, `effect/http-api`,
`effect/sql`, `effect/cli`, `effect/reactivity` (Atom, AtomHttpApi, AsyncResult),
`effect/socket`, `effect/process`, `effect/rpc` (if D-08 adopts `RpcClient`), `FileSystem`,
`Path`, `Crypto`, `Terminal`, `Stdio`,
`effect/testing` except `TestClock` (stable), and every non-`effect`
package. Policy: exact pins for all Effect packages and `vitest`; upgrades are separate
ledger items with their own parity run; no API from an `experimental` module.

## 3. Target architecture

The port keeps every observable behaviour and on-disk format except the CLI changes listed
in 3.1 (BC-CLI-01..04) and the D-21 rollback fix. What changes is the structure: one Layer
graph owns every resource, controllers are Effect services, all time goes through `Clock`,
all I/O goes through platform, socket, HTTP or SQL services, untrusted data is decoded with
`Schema`, and tests use injected Layers. Pure calculations, types and JSX stay plain.

### 3.1 Process, CLI and configuration (CC-CLI, CC-CONFIG, CC-SHUTDOWN, CC-HEALTH)

- **Entries.** From S6c (with the CLI port), `src/main.ts` exports the server program and
  calls `NodeRuntime.runMain` only when it is the process entry (`import.meta.main`,
  Node ≥ 24.2), so `node dist/main.js` (Dockerfile `CMD`, `npm start`) and
  `t3-supervisor start` run the same program under exactly one `runMain`; until then the
  unported `start` keeps importing `main.ts`, whose top-level `runMain` stays as today. The
  other entries are `src/cli.ts`, `scripts/probe-t3.ts`, `scripts/run-tests.ts` and
  `ui/src/main.tsx`.
- **CLI (Andrea: Effect end to end, `effect/cli` extension points first; S6c).** `src/cli.ts` is
  an `effect/cli` program under `runMain` (`disableErrorReporting: true`): root
  `t3-supervisor` with subcommands `start` and `auth forge`, each with an optional
  `--data-dir`. Extension points: `CliConfig.layer({builtIns: [GlobalFlag.Help]})` (no
  version/wizard/completions/log-level built-ins), `Flag.String` +
  `Flag.withSchema(AbsolutePath)` so relative paths are rejected, never resolved
  (`Flag.Directory` would resolve them), and a typed `CliUsageError` with
  `Runtime.errorExitCode` 2 that replaces `CliError.ShowHelp` after effect/cli has rendered
  help (`cli/Command.ts:2751-2764` prints help on stdout and errors on stderr;
  `cli/CliError.ts:656` would otherwise exit 1). `start` yields the server program;
  `auth forge` runs `ForgeGrant` without loading full configuration and writes exactly one
  token line to stdout; failure is `ForgeFailed` (fixed stderr message, exit 1).
  Preserved: commands, `--help`/`-h` on stdout with exit 0, exit 2 for usage errors,
  token-only successful stdout with empty stderr, absolute-path security, `--data-dir`
  precedence over `DATA_DIRECTORY`, the shebang
  `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning` with its executable bit,
  and no token in logs, errors or test failure messages. Intended behaviour changes
  (manifest `behaviorChanges`, to be acknowledged by both reviewers): **BC-CLI-01** help
  text rendered by effect/cli; **BC-CLI-02** a usage error prints help on stdout and the
  error on stderr (baseline: usage on stderr, empty stdout), still exit 2; **BC-CLI-03**
  `--data-dir=/abs` accepted; **BC-CLI-04** startup failures print no stack. No
  compatibility parser reproduces decorative help text.
- **Configuration.** One `SupervisorConfig` service built from `Config` over
  `ConfigProvider.fromEnv`, keeping today's names, defaults and validation; parsing keeps
  `preserveEmptyStrings` and `Number()` semantics (D-06). Token files are read through
  `FileSystem` and decoded into `Redacted` values (non-empty after trim; an absent optional
  file keeps the feature disabled). The fields `main.ts` mutates today become root
  services (`ThreadPolicy`, `SupervisorOwnership`) in S2; unported readers receive the
  same objects through the composition root (B-02/B-03, 3.9), and until S6d
  `ThreadPolicy` exposes the existing synchronous store (D-01).
- **Logging.** A JSON `Logger` keeps the one-line `{"time","event",...}` shape and logs
  only sanitized classifications (3.10). `Headers.CurrentRedactedNames` gains
  `x-supervisor-session` and `x-csrf-token`; the HTTP logger stays disabled.
- **Health and status.** `src/supervisor.ts` (S2) serves health from an `HttpRouter` on
  `NodeHttpServer` with the same port, paths, bodies and status codes; status is a `Ref`
  written by the maintenance, watch and supervision fibers.
- **Shutdown.** `runMain` interrupts on SIGINT/SIGTERM (exit 130, interrupt-only). The
  Layer graph releases supervision and listeners before stores, reversing today's window in
  which the catalog store closes first (D-10, target-regression CT-MAIN-02). A signal during
  partial Layer acquisition releases what was acquired, in reverse order.
- **Compiled bin and probe (SOL-PLAN-05, O-03).** CT-CLI-BIN-01..03 run the built
  `dist/cli.js` and an installed bin (`npm pack` into a temp prefix, generated shim):
  table-driven representative argv/stdout/stderr/exit cases (not every tsx case again),
  `start` with SIGINT and SIGTERM after readiness and during partial acquisition, and a
  forge interrupted while waiting on the login lock. Failures print token lengths or
  hashes, never tokens. `scripts/probe-t3.ts` becomes a `runMain` program (S4) with
  CT-PROBE-T3-01..05 against a loopback fake T3 in a real child process (success line,
  failure exit 1, fixed 30 s deadline, SIGINT with temp-directory cleanup, read-only RPC
  traffic); real providers are never contacted.

### 3.2 Persistence (CC-GDB, CC-DBFILES, CC-FILEMODES, CC-AUTH, CC-CATALOG, CC-SQL-LIFETIME)

One `SqliteClient` per database file, provided to every store on that file through one of
four named interfaces, `CatalogDb`, `GuidanceDb`, `PolicyDb` and `AccessDb` (each a
`Context.Service` whose value is that file's `SqlClient`), so a generic `SqlClient` tag can
never shadow another file's client. Only the database layer module may call
`SqliteClient.make`/`layer` (lint rule). No fifth database and no compatibility API.
Client lifetimes match today's connections: catalog and policy for the process; guidance
and the server's access client for one supervision run (re-acquired after a degraded
restart, as `guidance-application.ts:28-31` and `guidance-ui.ts:144` do today; never two at
once); forge's access client per CLI operation. In 4.0.5 the transaction connection is a
per-client context key (`effect/src/sql/SqlClient.ts:179`); `withTransaction` propagates it
through the fiber context with SAVEPOINTs for nesting and rolls back on failure or interruption; statements
and transactions share one connection under `Semaphore(1)` (`SqlClient.ts:304-375`;
`@effect/sql-sqlite-node/src/SqliteClient.ts:345`). Plain statements borrow the permit per
statement, so sequences outside a transaction can interleave. Rules:

1. Exactly one client per file at a time. No store opens its own connection, so receipts,
   native proof, workflow edits, acknowledgements and Stop state that commit together today
   still commit in one transaction (Astra F-001).
2. Cross-service calls inside a transaction are plain Effect calls in the same fiber and
   inherit the transaction connection. `db.isTransaction` joins become nested
   `withTransaction` (SAVEPOINT); no inner failure is caught inside an outer transaction
   today (CC-NESTTX).
3. No native T3 call, HTTP call, filesystem write, sleep, `forkChild` or nested `run*`
   inside a transaction. Intent records (dispatch markers, `sending`/`committed` states,
   IDs) are committed before any native send (CC-RECEIPT-FIRST).
4. Interruption inside a transaction rolls it back. This failure mode does not exist in the
   baseline and gets target-regression tests.
5. `busy_timeout` waits still block the event loop (`node:sqlite` is synchronous). This
   known limitation is preserved, not erased (O-05): the plan only proves that the port
   adds no new in-process self-contention, using a measured single-client workload.
6. Acquisition is interruptible in the pinned 4.0.6 (`SqlClient.ts:288` and `:433-438`
   restore interruption around the connection acquisition and the semaphore wait):
   interrupting a fiber that waits for the connection returns at once, its body never
   runs and the current holder is unaffected. Transactions still stay short and contain
   SQL only, because every waiter queues behind the holder. (4.0.5 completed the
   interruption only after the holder released; SQL-406.)
7. A failed COMMIT is rolled back under the semaphore before the connection is reused;
   nested `withTransaction` failures roll back to their SAVEPOINT.

Target-regression SQL tests on the real driver (S3 for CatalogDb, S6c for AccessDb, S6d
for GuidanceDb/PolicyDb): **CT-SQL-01** an interrupted waiter returns while the holder still
holds the connection, its body never runs and the holder commits unaffected; **CT-SQL-02** interruption inside a body rolls back and
the connection is reusable; **CT-SQL-03** a failed COMMIT is cleaned up and the next
transaction succeeds; **CT-SQL-04** two independent clients on one file in different
processes keep CAS (`UPDATE … AND revision=?`) and grant consumption correct under
BEGIN IMMEDIATE.

| File | Owner | Journal | Guarantees | Client | Slice |
| --- | --- | --- | --- | --- | --- |
| `catalog.sqlite3` | `store.ts` | WAL | `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=256`, `secure_delete=ON`, `max_page_count`; dir 0700, db/-wal/-shm 0600 | `CatalogDb`; file created and chmodded 0600 before open, pragmas after open; process lifetime | S3 |
| `access/login.sqlite3` | `service-auth.ts` (server and `auth forge`) | **DELETE** (validated) | `synchronous=FULL`, `busy_timeout=5000`, `max_page_count`; exactly two STRICT tables; caps/TTL; `quick_check`; O_NOFOLLOW + dev/ino identity before open and lstat re-check after open; size bounds; CLI never bootstraps | `AccessDb` = `SqliteClient.make({disableWAL: true})` after the private-files checks: **one client for the lifetime of the dashboard HTTP server** shared by every login/session/revocation operation (baseline `createServiceAuth`, `service-auth.ts:420-528`, opened at `guidance-ui.ts:144` and closed with the server at `:333/:348`; re-acquired with the server after a degraded supervision restart, released after the server's listeners), and **one short-lived client per forge operation in the separate CLI process** (`forgeDashboardToken`, `:530-566`). Never two clients in one process: a second client's synchronous busy wait would block the event loop while the first is suspended inside a transaction (Astra's 4.0.5 probe: `harness-probe/auth-client-contention`, LockTimeoutError after 53 ms). Cross-process contention stays BEGIN IMMEDIATE + `busy_timeout` (CT-AUTH-05, CT-SQL-04) | S6c (with its only callers: the HTTP auth checks and the CLI; 3.9 T-01) |
| `guidance.sqlite3` | `guidance-store.ts`; shared by project-supervisor, workflow-state, conversation, monitor and team stores, helper transport, write controller, git probe | WAL | `synchronous=FULL`, `busy_timeout=5000`, `secure_delete=ON`, `max_page_count=16384`; idempotent DDL at open; restart recovery (CC-RECOVERY) | `GuidanceDb` (S6d); until then the existing synchronous store (3.4); ownership preload from the same layer | S6d |
| `thread-settings.sqlite3` | `thread-policy.ts` | WAL | `synchronous=FULL`, `busy_timeout=5000`; single-row document read on every Stop check (`thread-policy.ts:22-24`, no cache) | `PolicyDb` (S6d); reads stay authoritative DB reads; Stop/Enable commits are ordered against send admission by the admission section (3.11) | S6d |

`SqliteClient.make` switches to WAL inside `make`, before any caller chmod, so files are
created and chmodded 0600 first (CC-FILEMODES). Extension loading is disabled right after
open; a lint rule bans `loadExtension`. No `SqliteMigrator` (D-04): it would add a
migrations table to existing user databases and break the login DB's two-table validation.

### 3.3 Atomicity of synchronous sections (CC-SYNC-ATOMIC, CC-GDB-IMPLICIT)

Baseline code gets atomicity from run-to-completion JavaScript: 16 modules issue SQL on
shared connections and 43 `transaction(` sites in 12 modules open explicit transactions,
most spanning several stores. Many read-modify-write sequences have no transaction at all
(CC-GDB-IMPLICIT). In Effect, other fibers can run at any `yield*`, and the runtime yields
inside long synchronous chains. Rules:

1. Each baseline synchronous block with more than one statement becomes one
   `withTransaction` (S6d) or, before S6d, one `Effect.sync` thunk (3.4).
2. Each synchronous read-check-update of in-memory state becomes one `Ref.modify`,
   `SynchronizedRef.modifyEffect` or a section under the owning `Semaphore`.
3. Every place where the baseline awaits between a check and a write keeps exactly that
   window; widening or narrowing it is a ledger item.
4. Baseline characterizations pin the observable outcome with present seams (concurrent
   calls, real abort, real sockets, process kill). Forced fiber yields and Effect
   interruption are target-regression tests after the owning port; they are never presented
   as baseline proof (5.1).

### 3.4 Sequencing of the shared guidance database (D-01)

`guidance.sqlite3` cannot move to `SqlClient` store by store: a second connection to the
file deadlocks or returns SQLITE_BUSY while the Effect client holds a transaction across
yields. Porting the stores first is not possible either: Promise controllers open
synchronous transactions spanning several store calls. Effect-typed store methods built on
`Effect.sync` are unsafe on their own: a fiber can yield between two `yield*`s inside an
open `BEGIN IMMEDIATE`, and another fiber's statement then joins that transaction through
the existing `isTransaction` checks. Plan:

1. S4–S6c port transports, controllers and the edge to Effect services. They call the
   existing synchronous store API, exposed to ported code only as the interim services
   `GuidanceStoreSync` and `PolicyStoreSync` (the existing objects, acquired exactly where
   they are acquired today), and only inside explicit `Effect.sync` critical sections, one
   per baseline synchronous block. Each thunk runs to completion, so atomicity is exactly
   the baseline's and is visible in code. No second connection is opened.
2. S6d switches the whole file, together with `thread-settings.sqlite3`, in one commit
   series after every caller is ported: `GuidanceDb`/`PolicyDb`, every store method becomes
   an Effect, every critical section becomes `withTransaction`, the CC-GDB-IMPLICIT
   sequences are wrapped, and the synchronous API and both interim services are deleted.

Every affected manifest row lists its `phases` (S0 mechanical test conversion; S4–S6c
interim synchronous critical sections; S6d SQL). No row promises a `SqlClient` layer for
these files before S6d.

### 3.5 Controllers, time and identities (CC-CLOCK-ELAPSED, CC-CLOCK-WALL, CC-IDS, CC-SCOPE-SERIAL)

Each controller becomes a `Context.Service` with a Layer. Durable state machines stay rows;
in-memory state uses `Ref`/`SynchronizedRef`; in-flight jobs use `FiberMap`; per-scope
serialization uses `ScopeLocks`, an `RcMap<key, Semaphore>` **leased per operation**
(`RcMap.get` inside the operation's own `Effect.scoped`), so a completed, failed or
interrupted caller releases its key like Scanner's release-on-last-user lock; a Layer-wide
scope retaining every key is not allowed (O-04, pinned by CT-PS-11 with a queued
cancellation). Cross-cycle retries stay persisted data compared with the clock, not
`Schedule`. The supervision loop is `Effect.repeat(Schedule.spaced("5 seconds"))` after
each cycle with `Effect.timeout("120 seconds")` per cycle. Business code never calls
`Effect.run*`.

Time has two domains (SOL-PLAN-08, A-P08):

- **CC-CLOCK-ELAPSED.** In-memory budgets and deadlines use monotonic time:
  `Clock.monotonicTimeNanos` (`Clock.ts:333`, converted once to milliseconds by one helper)
  or `Effect.timeout`/`Effect.sleep`. Baseline sites: `t3.ts:567`,
  `t3-projection-stream.ts:28-29,69,259`, `workflow-write-controller.ts:1048,1060,1122`.
  A wall-clock jump never enlarges or shrinks these budgets (CT-CLOCK-01, a custom `Clock`
  layer jumping wall time while monotonic time advances). Real 5000 ms projection-stream
  deadlines and event-loop fairness tests stay unchanged.
- **CC-CLOCK-WALL.** Persisted timestamps, TTLs, cooldowns compared across restarts and
  session expiry use `Clock.currentTimeMillis` where the baseline used `Date.now`. Native
  event times are copied untouched; `TestClock` values never replace native timestamps.

IDs come from one `SupervisorIds` service (`Crypto.randomUUIDv4`, `NodeCrypto` layer,
`TestCrypto` in tests) with unchanged persisted formats (CC-IDS). Pure builders that call
`randomUUID` today (`supervisor-workflow.ts:471,1026,1231`) receive allocated IDs or the
existing `nodeIds` generator option from their caller instead; they stay pure, not
Effects.

### 3.6 Native transports (CC-T3RPC, CC-WSFRAME, CC-NATIVE, CC-FILES, CC-PROBE)

The native frames (`Request`/`Ack`/`Ping`/`Pong`/`Chunk`/`Exit`) are the `effect/rpc`
`RpcMessage` protocol (`effect/src/rpc/RpcMessage.ts:72-442`, `src/t3.ts:685-721`), but are
implemented by hand six times. S4 replaces them with one shared implementation (D-08):
`RpcClient` over `Socket` only if a spike against recorded real frames proves exact
behaviour, otherwise one Effect envelope adapter over the socket. The spike must show
exact limits, Ack timing (Ack only after durable ingest), close/terminate and the sent
boundary, and that interruption sends **no** extra wire `Interrupt` frame and no early Ack:
`RpcClient` 4.0.5 emits `Interrupt` by default (`rpc/RpcClient.ts:678-681`) whereas the
current adapters terminate the socket. Wire-shape similarity alone is not parity. Either
way:

- per-call `maxPayload` (32/8/2/2 MiB) and binary-frame rejection are kept;
- a custom `Socket.WebSocketConstructor` keeps a permanent `error` listener (otherwise a
  handshake timeout can surface an unhandled `ws` error) and terminates on release;
- the "sent" boundary separating `rejected` from `uncertain` (CC-NATIVE) stays observable;
- an unknown outcome is never retried under a new ID; native timestamps are not rewritten.

### 3.7 HTTP API, auth and MCP (CC-HTTPAPI, CC-WEBSEC, CC-AUTH, CC-MCP)

`SupervisorApi` already declares every `/api/guidance/*` endpoint
(`src/guidance-contract.ts:96-160`); handlers become Effect services without `tryPromise`
wrappers (S6c, after every service they call). Host/Origin/CSRF/session checks stay
router-level `HttpRouter` middleware with the exact check order, `{"message"}` bodies,
statuses and headers (D-12); `/auth/*`, `/api/csrf` and static files move onto the same
router. Login, session and revocation run on the one server-lifetime `AccessDb` client;
CT-AUTH-05 races concurrent real HTTP logins for one single-use grant through the shared
Layer and expects exactly one session and no in-process busy-wait failure, next to a
cross-process forge. `/mcp/workflows` stays stateless Streamable HTTP with direct bearer
authentication and no proxy. Effect's `McpServer` is sessionful for every protocol version
up to 2025-11-25 (`ai/McpProtocol.ts:211-254`, `ai/McpServer.ts:915-931`), so the SDK
`StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`, fresh per
request) stays as a scoped adapter inside an Effect route that owns auth, the 1 MiB body
bound, the 9 s deadline, abort and close (D-03). The SDK's Promise tool callbacks run
Effects through the request fiber's captured context (`Effect.context` +
`Effect.runPromiseWith`, forks tracked in a request-scoped `FiberSet`); this is the only
`run*` allowance outside the entries, it never builds a runtime or Layer (which would lose
the SQL transaction context), and CT-MCP-03/04 prove abort and SDK close (O-06).

### 3.8 UI (CC-UI-SESSION, CC-UI-DRAFTS, CC-UI-MUTATION, CC-START-FENCE, CC-BINDING-GEN)

`AtomHttpApi.Service` covers every endpoint; one `RegistryProvider` per page whose runtime
layers are fixed at creation (no layer replacement through registry initial values, which
4.0.5 mishandles, #9313). Markup, classes, strings and CSS do not change. Rules
(SOL-PLAN-06, A-P06):

- **Queries** are atom families keyed by the full scope tuple the panel depends on:
  T3 environment, project, main chat, binding generation or checkout, section and auth
  epoch. A key change disposes and interrupts the old read; polling uses
  visibility-aware refresh signals. A failed refresh keeps the last successful read;
  this is pinned by a test, and only a demonstrated failure of the 4.0.5 atom (#9607)
  justifies a minimal ledgered fix, never a duplicate retained-success store.
- **Mutations** (Save, Start, Stop/Enable, setup, login, logout) are admitted once per user
  action and are never interrupted by a scope change, re-render, unmount, auth refresh,
  refetch, runtime rebuild or a second invocation ("latest wins" applies to reads only).
  Each admitted mutation is owned by a keep-alive atom family keyed by scope and operation
  ID in the page registry: a second invocation while it is in flight returns the same
  handle (duplicate suppression); its outcome (saved / not saved for 401, 403, 413, 415 /
  unconfirmed) is retained across unmount and shown only for its original scope; a new
  scope ignores it. An unknown outcome keeps its durable fence (Start fence in storage,
  setup fence) until a verified read. Nothing replays a mutation; Save/Retry after access
  refresh is always an explicit user action. A consumed single-use login result is
  stored even if its component unmounted.
- **Drafts** live in keep-alive writable atom families keyed by the scope tuple without the
  auth epoch, so they survive section/project/chat navigation, session expiry and
  re-sign-in exactly as today; per-panel reset rules (cleared after a verified save, kept
  on failure or uncertainty, discarded by explicit cancel) are copied from the baseline
  components, including the configuration editor and setup controls.
- **Browser adapters** (localStorage + `storage` events, history/hash, `beforeunload`,
  `document.title`) stay small adapters whose listeners are released with their atom or
  component (section 9).
- **Mounted proof (D-19).** Before S7 the coordinator records the mounted baseline stories
  UI-STORY-01..08 (section 7) on the baseline build and replays them after S7. Atom tests
  complement these mounted proofs; they do not replace them. No DOM test dependency is
  added.
- **Guidance order.** Modern Web Guidance first, Impeccable as the primary design skill,
  then wcag-accessibility, preserving `PRODUCT.md`, `DESIGN.md`, `.impeccable/*` and the
  current design. The pinned sources and the exact S7 procedure are prepared read-only in
  `/tmp/effv4-ui-skills/PREPARATION.md` (Impeccable 4.7.0 `aeeb3d8c`, Modern Web Guidance
  `65e7edd6` / CLI 0.0.195, WCAG skill `a4ae0ca6`); nothing is installed globally.

### 3.9 Service transition map and temporary boundaries (A-P01, SOL-PLAN-03)

The slices follow the runtime call graph bottom up, so a ported module only ever calls
ported services of the same or an earlier slice (plus the D-01 interim stores inside
`Effect.sync`). The baseline graph has two kinds of upward calls that would break this:
callbacks that lower objects receive from `ProjectSupervisor`
(`project-supervisor.ts:108-117`: `scopeEnabled`, `workflowEditingEnabled`,
`supervisionStopped`, `eligible`, `projection`) and the write controller's options closed
over `ProjectSupervisor` (`guidance-application.ts:84-102`: `isEnabled`, `isChatStopped`,
`starts`, `stops`). They are removed by **dependency extraction** at the start of S6a, on
the Promise code, before any S6a port: methods move verbatim, with no new `await` and no
change to any synchronous block, verified by the S1 suite.

- `src/supervision-gate.ts` (new): `SupervisionGate` = the scope predicates
  (`scopeEnabled`, `projectEnabled`, `validPendingStart`, `workflowEditingEnabled`,
  `supervisionStopped`, `isNoProject` with the scratch-classification memory, `eligible`,
  `mainShape`) as synchronous reads usable inside critical sections, plus the send
  admission section of 3.11. `projection` callbacks become direct `T3Client.projection`
  calls (`project-supervisor.ts:199` is only that).
- `src/supervision-control.ts` (new): `SupervisionControl` = Start/Stop/Enable
  (`requestStart`, `evaluateStart`, `activateStart`, `rejectStart`, `startSupervision`,
  `dashboardStart`, `startStatus`, `stopSupervision`, `writeChatPolicy`, `applyChatStop`,
  `saveThreadPolicy`, `genuineUserMessage`). Its dependencies (gate, catalog, projection,
  stores, conversation fence, operate RPC) are all lower; `setChatSupervision`,
  `prepareStarts` and `ensureBinding` stay in `ProjectSupervisor` and call it.

Resulting order (each line calls only lines above it):

| Slice | Services (call order) |
| --- | --- |
| S2 | `SupervisorConfig`, `SupervisorIds`, `Logger`, elapsed-clock helper, redaction, `ThreadPolicy`/`SupervisorOwnership` root services, server program (`main.ts`), health/status (`supervisor.ts`) |
| S3 | `Store` (`CatalogDb`) |
| S4 | native envelope, `T3Client` + projection stream, `SupervisorNative`, `ProjectFiles`, `GitProbe`, probe script |
| S5 | `ProjectDefinitionLoader`, `ProjectConfigEditor` |
| S6a | extraction commits; pure modules; `ScopeLocks`; `SupervisionGate` (+ admission, 3.11); `HelperTransport`; `TeamRuntime` |
| S6b | `SupervisorConversation` → `SupervisorLifecycle` → `SupervisionControl` → `WorkflowWriteController` → `SupervisorTeamController` → `ProjectSupervisor` → `WorkflowProgress`, team view, dashboard overview |
| S6c | `ServiceAuth` (`AccessDb`), CLI, `GuidanceRuntime`, MCP route, HTTP handlers/router/auth routes/static, `SupervisionLive` (replaces `runGuidanceApplication`) |
| S6d | `GuidanceDb`/`PolicyDb` engine switch (all callers already ported) |
| S6e | typed interpretation submission (3.12; attempt-bound submission, prompt return, completed-run finalization) |
| S7 | UI |

`ProjectSupervisor` still calls the team controller for reconciliation (today's late-bound
`teamEffects`, `project-supervisor.ts:98,1230-1266`); with the team controller ported
first, that is a plain downward service dependency. `SupervisorConversation` only imports
types from the write controller. Two upward edges are allowed because no Promise bridge is
involved: a callee that is a D-01 interim store (B-02), and a callee that already exposes
an Effect API at baseline (`Store`, `T3Client`, and `runGuidanceApplication`, which the S2
server program keeps forking unchanged until S6c). Imports of pure exports of a ported
module (helpers, schemas, error classes such as `record`, `SupervisorRpcError`,
`DashboardOverview`) need no boundary. The manifest generator checks the baseline import
and constructor-injection graph against these rules: zero violations
(`summary.sliceFeasibilityViolations`).

**Temporary boundaries.** Because the root is already an Effect program, every boundary
between ported and unported code lives in the composition root
(`runGuidanceApplication`, itself an `Effect.gen`) and in the constructor parameters of the
unported classes it builds. Ported modules contain none. All boundaries use the services of
the one root context; none builds a runtime, rebuilds a Layer or opens a connection.

| ID | Signature | Owner (scope) | Removed in |
| --- | --- | --- | --- |
| B-01 | `const run = Effect.runPromiseWith(yield* Effect.context<RootServices>())`: `(effect, {signal}) => Promise` handed to unported objects | `runGuidanceApplication` run scope (one capture per supervision run) | S6c |
| B-02 | interim `GuidanceStoreSync`/`PolicyStoreSync`: the existing synchronous objects, acquired where they are today and passed by reference to unported constructors | guidance: supervision run; policy: process (`main.ts`) | S6d |
| B-03 | facades for each ported service an unported caller still uses, built in `runGuidanceApplication` from the captured context and handed over through constructor parameters. Each method keeps its baseline shape (`temporaryBoundaries.callShapes`): an asynchronous method becomes `(args, signal) => run(service.op(args), signal)`; a synchronous method stays synchronous only when it is pure or a read/write over the B-02 stores (for example `HelperTransport.hasDelivery`, `TeamRuntime.partition`, `SupervisorConversation.status`, `WorkflowWriteController.resolveBinding`, the gate predicates). Any other synchronous use is a caller transition (B-04) | composition root | the slice that ports the last unported caller; all by S6c |

**Synchronous call sites (B-04).** A Promise facade cannot stand in for a synchronous call:
a Promise is always truthy in a condition, and login/revoke order would be lost. Each
transition below is a narrow, ledgered call-site edit in the still-unported consumer, made
in the same commit as the callee change, preserving check order and login/revoke behaviour. Every synchronous call from a still-unported
caller into a service ported earlier is therefore given an explicit transition, listed in
the manifest (`syncTransitions`):

| ID | Synchronous call sites | Transition |
| --- | --- | --- |
| T-01 | `guidance-ui.ts:187-224`: `auth.mcpAuthorized`, `auth.authenticated`, `auth.login`, `auth.logout` inside request conditions | `ServiceAuth` cannot stay synchronous once it runs on `AccessDb`, so it ports in S6c together with these HTTP checks, the `/auth/*` routes and the CLI (`auth forge`); S3 keeps only the catalog store. No facade |
| T-02 | `guidance-ui.ts:129-137` `supervision.saveThreadPolicy` inside an `Effect.try` handler; `guidance-ui.ts:62,66` `noProjectControl` and `startStatus` inside `Effect.try` handlers | `saveThreadPolicy` becomes asynchronous in S6a (T-07); the same S6a commit changes that handler to yield the admitted Effect directly (the handler is already an Effect), mapped to the same `UiError`. `noProjectControl` and `startStatus` stay synchronous B-02 reads until S6c, when the handlers port |
| T-07 | the extracted, still-Promise `SupervisionControl` Stop, Enable, thread-policy save and chat-supervision paths, and the Start activation blocks in `prepareStarts` and `reconcile` (`project-supervisor.ts:670-679,780-795,1466-1474`), from S6a until S6b | in S6a, when the first ported send can yield between its guard and its `initiate`, each of these legacy policy writes runs its existing synchronous block as one `Effect.sync` inside `run(gate.admit(...))` (B-01), awaited by the Promise caller; Start activation acquires the admission section before opening its guidance transaction, never from inside it |
| T-03 | `project-supervisor.ts`, `supervisor-lifecycle.ts` → `SupervisorConversation` (`status`, `hasInflight`, `supervisionStopped`, `interpretationRole`, `roleDelivered`, `retry`, `fenceStoppedSupervision`; `reconcileStopNotice` is asynchronous at baseline, `supervisor-conversation.ts:1687`, awaited at `project-supervisor.ts:1221`, and uses the B-03 asynchronous facade) during the S6b commit series | these stay synchronous methods over the interim stores (B-02) until S6d; `fenceStoppedSupervision` runs inside the Stop bookkeeping critical section |
| T-04 | `supervisor-conversation.ts:1443,1480,1667,1917,1920` and `supervisor-lifecycle.ts:114,355` → `TeamRuntime` (`startCycle` in-memory; `partition`, `coordinatorPolicy`, `rootOwnedBatch`, `hasBlockingWork`, `hasInflightEffects` B-02 reads; `acknowledgeRootEvents` B-02 write) between S6a and S6b | stay synchronous until S6d; `TeamRuntime`'s own calls to `HelperTransport.receiptText`/`matchesMessage` (B-02 reads) stay inside WP-S6a-SEND |
| T-05 | `cli.ts:3,28` → `config.loadDataDirectory` between S2 and S6c (`guidance-ui.ts:144`'s direct `createServiceAuth` factory import disappears with T-01, because ServiceAuth and that caller port together) | a retained pure data-directory resolver (flag and environment in, path out) in `config.ts`, not a facade; the forge process has no supervision runtime. In S6c the CLI resolves it through `SupervisorConfig` in its own `runMain` |
| T-06 | gate predicates (`scopeEnabled`, `supervisionStopped`, `workflowEditingEnabled`) and `workflowLocator` (`workflow-progress.ts:244-257`), B-02 reads from unported callers | synchronous by design (3.9); guarding uses go through the admission section (3.11) |

Store calls into the D-01 stores are B-02, not transitions. A synchronous method kept for an
unported caller is a plain read or write over B-02 stores or a pure computation; it never
hides an asynchronous implementation. The extracted call shapes (`temporaryBoundaries.callShapes`)
have no other cross-slice synchronous method: `globalHomePath`/`globalDefinitionsPath` are
pure, and `SupervisorTeamController.reconcileStopped` already returns a Promise.

Two lower services are constructed inside unported classes today and become injected
facade arguments in the commit that ports them: **I-01** `SupervisorHelperTransport`,
constructed by `ProjectSupervisor` (`project-supervisor.ts:109-110`), becomes a constructor
parameter of `ProjectSupervisor` (and is passed on to `SupervisorConversation`) in S6a;
**I-02** `SupervisorTeamRuntime`, constructed by `SupervisorConversation`
(`supervisor-conversation.ts:306`), becomes a constructor parameter passed through
`ProjectSupervisor` in S6a. Both are built once in `runGuidanceApplication` from the root
context and removed in S6b, when those classes become Layers.

The ledger in the manifest (`temporaryBoundaries`) lists each B-03 facade with its
consumer, service operation and removing slice. S6c deletes B-01 and every B-03 facade; S6d
deletes B-02. From S2 a lint rule bans `Effect.run*` outside the entries, the MCP adapter
(3.7), test harness files and, until S6c, `guidance-application.ts`. A whole old controller
wrapped in `tryPromise` is never counted as ported.

### 3.10 Errors, Schema boundaries and log privacy (A-P07, SOL-PLAN-09)

- **Errors.** Local diagnostic errors use `Data.TaggedError`. Errors that cross a wire,
  persisted state or an HTTP/MCP boundary use `Schema.TaggedError` with a stable shape and
  an inner `reason` union where callers branch. `SupervisorRpcError` keeps its four flags
  (`outcome`, `definiteRejection`, `providerDisabled`, `dispatchCommandFailure`). HTTP
  bodies keep their exact JSON.
- **Schema is mandatory** at every untrusted input, persisted row and model output:
  environment and token files; HTTP request bodies (HttpApi); MCP tool arguments; native
  frames, projections, thread lists and turn items; stored JSON in `guidance.sqlite3`,
  `thread-settings.sqlite3` and `catalog.sqlite3`; authored project YAML/Markdown after
  `yaml` parsing; interpretation, review and proposal model outputs (interpretation through
  the typed submission tool after S6e, 3.12). Each manifest row
  names its decode boundary. The schemas accept exactly today's acceptance set: existing
  pure validators and exact reason codes run inside or right after the decode
  (`Schema.declare`/checks/transformations), so diagnostics, their order and the
  `incompatible` classification of unknown historical rows are unchanged. There is no
  `JSON.parse` + type assertion fallback, no optional schema and no migration format.
- **Raw input retention.** For MCP and native proof, the original unknown payload is kept
  next to the decoded value and used for exact size, hash and argument binding
  (omitted versus `null` preserved). Where the baseline rejects excess or forbidden fields,
  decoding uses `onExcessProperty: "error"` (`SchemaAST.ts:539`) and rejects them; nothing is
  stripped into authority. Where the baseline ignores unknown native fields, decoding keeps
  ignoring them and the raw value stays the proof source. Advertised MCP JSON Schemas stay
  hand-written and byte-identical (CT-WWC-06), separate from runtime decoding. Excess-field
  and truncated-argument cases run through the real controller (CT-INT-01) and the real
  HTTP endpoint (CT-UI-08).
- **Log and span privacy (CC-REDACT).** Logs and spans carry only sanitized typed
  classifications (error tag, reason code, HTTP status, sizes, hashes, IDs). They never
  contain raw causes, tokens, cookies or `Authorization` values, native error bodies, or
  capability URLs (the webhook path). `Cause` objects are classified before logging, never
  printed. CT-REDACT-01 sends a nested cause carrying a token, a native error body and a
  webhook URL through the logger and a span and asserts none appears.
- **API spellings.** Every target API in the manifest is checked against the installed
  4.0.5 source (`Layer.effect` for scoped construction, `Schema.fromJsonString`,
  `Context.Service`); `Layer.scoped` and `Schema.parseJson` do not exist in 4.0.5. S1c adds
  a compile-only probe file importing every planned API.

### 3.11 Stop/Enable publication and send admission (CC-STOP-LIN; A-P03, SOL-PLAN-02)

Baseline facts (W4, manifest `contracts.CC-STOP-LIN`). Policy reads are synchronous
database reads on every check (`thread-policy.ts:22-24`, `currentThreadPolicy` `:35`);
there is no in-memory snapshot, so the policy commit itself is the publication point. All
18 native write paths are listed with guard, receipt and initiation lines in
`CC-STOP-LIN.paths`; every message send already runs final guard → receipt commit → native
initiation in one synchronous turn (for example helper POST
`supervisor-helper-transport.ts:389-394`, root check-in `supervisor-conversation.ts:
1780-1786`, introduction `:1979-1991`, guide `supervisor-team-controller.ts:487-554`,
interpretation `project-supervisor.ts:1350-1362`, thread creation `:1089-1110`). Every Stop,
Enable and Start activation commits `thread-settings.sqlite3` before its guidance
bookkeeping with no await between (`project-supervisor.ts:980-985`, `:997-1001`,
`:1014-1020`, `:670-679`). Effect would open new scheduling windows between those steps;
this contract closes them.

1. **One admission section.** `SupervisionGate` owns one process-wide `Semaphore(1)`.
   (Per-scope keys would also satisfy the contract but need multi-key ordering for bulk
   policy saves; the sections contain only synchronous store work, at most one `initiate`
   and its handle registration. The manifest's
   `CC-STOP-LIN` uses the same process-wide section; W4's per-scope draft is superseded.)
   - Stop, Enable, thread-policy saves, dashboard chat-supervision changes and Start
     activation run inside it: policy commit, then the guidance bookkeeping (start
     rejection, unbound stop, `setSupervisionStop`, `setStopNotice`,
     `fenceStoppedSupervision`, `recordChatEnable`).
   - Every fresh send path runs its final guard (authoritative policy and guidance reads,
     scope enabled, actor/assignment and receipt checks), its durable receipt commit and its
     **native admission** inside it.
   - Every **policy-dependent durable write** runs its guard and its write inside it: any
     guidance mutation whose guard reads the stop list, an Enable time or the scope
     predicates in the same baseline synchronous block (task creation and queueing, start
     records, binding updates, interpretation application, introduction and notice
     preparation, settlement records, stale marking), and explicitly the `workflow_write`
     commit (`workflow-write-controller.ts:1327-1355`), the `supervision_team` mutations
     (`supervisor-team-controller.ts:158-205`), the typed interpretation intake and
     finalization (3.12) and Start activation. A single-file transaction does not close the
     cross-file window: a writer holding `GuidanceDb` could otherwise read the policy, yield,
     and commit after a Stop committed `PolicyDb`. The
     generated inventory (`contracts.CC-STOP-LIN.policyDependentMutations`, 50 sites, e.g.
     `project-supervisor.ts:1356→1357`, `supervisor-conversation.ts:1984→1989`,
     `supervisor-lifecycle.ts:274→276`) is checked again at each port. To make this
     enforceable rather than a convention, the gate exposes its predicates for guarding
     only through an admission capability (`SupervisionGate.admit(f)`, where `f` receives
     the guard API); outside `admit` only display reads are available.
   - **Native admission** is the linearization point of a send. It is the adapter's
     synchronous handoff, not a fiber fork: every native transport exposes
     `initiate(request): Effect<InFlight>`, implemented with `Effect.sync`, which
     irrevocably commits the request exactly as today (the WS RPC request frame bound to a
     newly created socket and sent on open, as `supervisor-native.ts:23,35-41` does; the
     helper webhook `fetch` invoked with its body, as `supervisor-helper-transport.ts:394`
     does) and returns at once with `InFlight` = `{result, release}`, where `release` is the
     adapter's local cleanup (close the socket, abort the fetch). `initiate` runs inside the
     section after the receipt commit; the section ends right after the handle is
     registered (next item). Socket open, the reply and any body read happen afterwards in
     `InFlight.result`, outside the section. Whatever the D-08 spike selects must expose
     this synchronous `initiate` step. Stop never interrupts an admitted send; its outcome
     is classified by the sent boundary and reconciled, never replayed under a new
     identity. No SQL transaction spans two files.
   - **In-flight lookup and resource ownership.** Each native adapter owns one
     service-lifetime `FiberMap<Identity, Outcome>` (in the adapter Layer's scope). Inside
     `admit`, before any fresh initiation, the send body (a) looks the identity up with
     `FiberMap.get` (`FiberMap.ts:796`): an entry is returned as a *duplicate* handle and
     nothing is initiated; (b) otherwise reads its durable receipt: an existing receipt
     (admitted, sent, unknown or completed) returns the existing reconciliation-only outcome
     and never starts another send because the map no longer holds the identity; (c)
     otherwise commits the receipt, calls `initiate` and registers the operation with
     `FiberMap.run(map, identity, operation)` in the same masked body. `onlyIfMissing` is
     not used: on 4.0.5 it returns an interrupted sentinel for an existing key
     (`FiberMap.ts:1427-1428`), and because every registration happens inside the section
     after the lookup a collision cannot occur. The operation is `InFlight.result` mapped
     to the path's baseline outcome classification for every reply, error and interruption
     (it never fails the map) with `Effect.ensuring(release)`. `FiberMap.run` forks it as
     an interruptible daemon fiber owned by the map (`FiberMap.ts:1430-1435`,
     `internal/effect.ts:5527-5536`), so cleanup ownership exists before the section ends:
     no interruptible point lies between `initiate` and the registered `release`.
   - **Cancellation owner.** The caller that initiated is the operation's only
     cancellation owner. The body stores the mapped fiber in the caller's owner cell before
     returning, and the whole send runs under `Effect.onInterrupt(() => owned ?
     Fiber.interrupt(owned) : Effect.void)`. The original caller's cancellation (request
     abort, the 120 s cycle deadline, shutdown of the calling scope), whether it arrives
     during the section, at its exit or while awaiting the reply, therefore interrupts the
     mapped operation and waits for its `release`, as today's `AbortSignal` reaches the
     socket and timers (`supervisor-native.ts:20-39`) and the helper POST
     (`supervisor-helper-transport.ts:394-395`); the outcome follows the path's baseline
     abort classification (unsent before the request left, uncertain after) under the
     original identity. Awaiting is `Effect.exit(Fiber.join(fiber))`, outside the section.
     A duplicate caller only joins: interrupting it ends its wait and never cancels or
     replaces the original, and an interrupted exit seen by a duplicate falls back to the
     receipt's reconciliation outcome. Stop does not touch the map. Closing the adapter
     scope (process shutdown) interrupts each in-flight operation and runs its `release`
     once; receipts stay for reconciliation. Executable evidence on exact 4.0.5:
     `docs/effect-v4-admission-probe.mjs` (cases and results below CT-LIN-05). A variant
     that returned the handle across an interruptible boundary lost ownership (the mapped
     operation was orphaned and the run timed out); this is why the owner cell is filled
     inside the masked body.
     The existing per-scope `serial` queue (`project-supervisor.ts:119-123`, `ScopeLocks` in
     the target) spans network work and is not the admission lock.
   - The section is one operation, `SupervisionGate.admit(f)`:
     `Semaphore.withPermits(admission, 1)(Effect.uninterruptible(f(guard)))`
     (`Semaphore.ts:462`). Waiting for the permit stays interruptible; the body, which
     contains only synchronous store work (or short `withTransaction` blocks after S6d) and
     at most one `initiate`, is uninterruptible. The guard predicates for writes and sends
     are only reachable through `admit`'s argument.
2. **Masking and order.** Each section body is uninterruptible (item 1); an interruption
   before the permit is acquired admits nothing. Acquisition order: `ScopeLocks` key (if held) → admission section →
   database critical section (`Effect.sync` before S6d, `withTransaction` after). The
   section is never acquired inside a transaction.
3. **Outcomes.** A Stop ordered before a send's admission makes its guard fail: zero fresh
   sends, and the path's baseline guard-failed state. A send admitted before the Stop keeps
   its original identity, is not cancelled or replayed, and reconciles to one outcome; Stop
   then produces exactly one operative notice, as today. Stop/Enable/Stop keeps the
   baseline notice rules (`supervisor-conversation.ts:1720`, `project-supervisor.ts:
   912-915`).
4. **Introduced together (S6a).** The admission section exists from the first S6a commit
   that ports a send (helper transport). In that same commit series the remaining legacy
   policy writers join it (3.9 T-07), so at every intermediate freeze each Stop, Enable,
   thread-policy save and Start activation is ordered against every ported send and
   policy-dependent write. Unported sends still run guard, receipt and initiation in one
   synchronous turn and cannot be interleaved. Start activation keeps the baseline order
   inside the section: policy write, then the guidance transaction commit, with the
   section acquired before the transaction opens. CT-LIN-02, -05 and -06 run at that first
   S6a freeze, including the unported callers.
5. **Preserved baseline limitations (not widened, not fixed in this batch).** A crash
   between the policy commit and the guidance bookkeeping keeps today's recovery behaviour.
   A bookkeeping failure after the policy commit keeps today's results (Stop: sends stay
   fenced but no notice is written and a dashboard retry returns `conflict`; Enable: a
   stale `chatEnabledAt`), pinned by CT-LIN-03. Three existing paths have no recheck after
   their awaits and keep exactly that behaviour: the helper channel `scheduledTasks.upsert`
   (`supervisor-helper-transport.ts:235-244`), the guide dispatch-failure replay
   (`supervisor-team-controller.ts:560-577`) and active-chat settlement
   (`supervisor-lifecycle.ts:346-404`). Repairing any of them is a separate ledger decision
   (L-01..L-03, section 13); none justifies a new in-process window.

Tests (5.4): CT-LIN-01 (policy commit before each path's next guard), CT-LIN-03 (failed
bookkeeping), CT-LIN-06 (Stop after initiation) and the interpretation variant of CT-LIN-04
are `s1-baseline`; CT-LIN-02 has a baseline probe and a target barrier variant; CT-LIN-04
for the other paths, CT-LIN-05, CT-LIN-07 and CT-LIN-08 are `target-regression`.

**CT-LIN-05, the executable admission contract** (`it.live`, S6a for the helper path, then
every send path), with a fake adapter whose `initiate` appends `"initiate"` to a `Ref` log
synchronously and returns an `InFlight` whose `result` waits on a `Deferred` reply:
1. Fork a send with `Effect.forkChild`; wait for `"initiate"`; then fork a Stop and
   `Fiber.join` it **while the reply `Deferred` is still unresolved**. The Stop completes,
   which proves no network response is awaited under the section; the log is
   `initiate, policy-commit, bookkeeping`; the send is not interrupted; resolving the reply
   records its outcome under the original identity; a duplicate send for the identity
   while the reply is pending finds the entry with `FiberMap.get`, initiates nothing and
   returns the original outcome.
2. Reverse order: the Stop holds the section through a `Deferred` barrier inside its
   bookkeeping; a concurrent send waits for the permit; after release its guard fails, the
   log has no `initiate`, and no receipt is written.
3. Interrupting the waiting send in (2) before it gets the permit leaves no receipt and no
   `initiate`.
4. Interrupting a duplicate waiter leaves the original running (`release` not yet run);
   the original's reply then completes it and `release` runs once.
5. The owner is interrupted inside the section after `initiate` and before registration
   (the fake `initiate` holds on a test barrier; production `initiate` is `Effect.sync`):
   the interruption takes effect at the section exit, `release` runs exactly once, the
   receipt is classified `uncertain`, and a later send of the identity is
   reconciliation-only with one `initiate` in total.
6. The owner is interrupted while awaiting the reply: as in (5); a duplicate waiter
   receives the reconciliation outcome; no second send.
7. Closing the adapter scope with a send in flight runs `release` once and keeps the
   receipt.

Probe results (`docs/effect-v4-admission-probe.mjs`, effect 4.0.5): duplicate while
pending → same `sent` outcome, 1 `initiate`; duplicate waiter interrupted → 0 releases
until the reply, then `sent`; owner interrupted at handoff → owner interrupted, 1 release,
receipt `uncertain`, later send `reconcile`, 1 `initiate`; owner interrupted awaiting
reply → duplicate and later send `reconcile`/`uncertain`, 1 `initiate`; Stop while the
reply is pending → Stop completes first, log `receipt, initiate, policy-commit,
bookkeeping, release`, send `sent`; Stop first → `denied`, no receipt; interrupt while
waiting for the permit → no receipt, no `initiate`; scope close → 1 release, `uncertain`.
The target CT-LIN-05 runs the same cases against each ported path's real adapter
boundary.
CT-LIN-07: `admit` called while a `GuidanceDb` transaction is open on the same fiber dies
with a defect (the per-client transaction key, `SqlClient.ts:179`, is present), so the
section is never acquired inside a transaction. CT-LIN-08: controlled interleavings for the
policy-dependent writes — a Stop ordered against `workflow_write`, a `supervision_team`
mutation, a typed interpretation intake and finalization, and Start activation, each with
the writer parked between its guard and its commit — show the write either commits before
the Stop or sees the Stop and writes nothing.

### 3.12 Typed interpretation submission and routing (CC-INTERP-SUBMIT)

IDs: ANDREA-ITOOL-01, ANDREA-ROUTE-01, ANDREA-ITOOL-EVAL-01, ANDREA-MODEL-01, and the
reviewers' design obligations SOL-ITOOL-1..8 and A-I01..A-I04 (section 13). Status: one
design reconciled from the owner proposal (v2), Sol's design report
(`sol-typed-interpretation-design.md`) and Astra's (`typed-interpretation-design.md`); both
reviewers recommend exactly this shape.

Andrea asked to replace free-form final-chat JSON interpretation parsing with a typed
Supervisor MCP submission tool validated with `Schema`, keeping exact native identity,
source, run and binding authority, with no T3 change, no permanent fallback and no
duplicate store, and asked whether the tool could also dispatch to the right thread. The
published `message.dispatch` has no `outputSchema`, so the final message cannot be typed
natively. Baseline path (`project-supervisor.ts:1262-1483`): `processProject` dispatches
the interpretation request to the bound root (`message.dispatch`, `commandId
supervisor-objective:<taskId>`, `:1360-1362`); `reconcile` waits for that run to complete
successfully (`:1425`), `JSON.parse`s the last assistant message (`:1440-1450`,
`parseInterpretation`/`parseWorkflowInterpretation`, `supervisor-workflow.ts:68,1467`),
revalidates definitions and source, then applies the result and any Start activation in one
transaction (`:1466-1474`); the same cycle introduces an `inferred` task through the
existing conversation path (`:1297-1299`), whose candidate evidence re-parses that final
answer (`supervisor-conversation.ts:1143,1535,1801-1830,1956`, provenance fields in
`supervisor-conversation-store.ts:45`). The early pilot failed exactly at the `JSON.parse`
step and failed closed; the original Codex provider JSONL shows the braces missing in the
model output itself (Luna HIGH, Luna MAX and Sol 6.1 LOW coding plans), not a T3
truncation. Model choice alone does not remove the dependence on free-form syntax; the
typed tool does. It does not fix semantic contamination from a reused root's history.

**Answer to "can the tool dispatch to the right thread?"** Yes in the sense that a
successful submission starts the existing service-owned delivery to the operative derived
from the binding. No in the sense of a model-chosen destination, route or run, or a send
inside the tool call: those would be different features and are rejected.

1. **Attempt identity.** One interpretation *attempt* is identified by an immutable key:
   binding generation, task ID, the task's current source revision (source message, run,
   ordinal and hash) and the dispatched interpretation request message ID (and its text
   hash). The task ID alone never identifies an attempt: the baseline keeps `task.id` and
   spreads the old task into the new one when the user edits the source
   (`supervisor-conversation.ts:846-861`, new `messageId supervisor-task-revision:*`, new
   source hash) and when approved definitions renew an unsent proposal (`:615-625`, new
   `messageId supervisor-task-renewal:*`). The service mints an immutable `attemptId` for
   the key when it builds the request text (the existing `processProject` step), and the
   envelope carries `attemptId` and the `sourcePin`. An identical replay of the same
   request keeps them; a renewal or source edit produces a new attempt. Both values are
   assertions checked against durable state; neither grants authority.
2. **Tool and arguments.** `supervision_interpretation_submit` on the existing
   `/mcp/workflows` endpoint (same bearer, Host/Origin checks, stateless SDK adapter, 9 s
   budget, cancellation and cleanup, 3.7). Arguments: `supervisorThreadId`,
   `bindingGeneration`, `taskId`, `attemptId`, `sourcePin`, `objective`, `reason`,
   `sourceMessageIds`, and by the task's state `supervision` + `workflow` (definition
   context present) and `startRequested` (only when the server holds a matching pending
   Start). No target thread, run, dispatch mode, delivery body, model/provider setting,
   proposal acceptance or callback exists.
3. **Decode.** `Schema.Struct`/`Schema.Union`/`Schema.Literals` decoded with
   `Schema.decodeUnknownEffect(..., {onExcessProperty: "error"})` (`Schema.ts:1524`,
   `SchemaAST.ts:539`), keeping the existing text, byte, depth, node, definition and
   expansion limits; no `Schema.Unknown` hiding workflow objects. The complete raw argument
   object and its canonical hash are captured before any normalization, trimming,
   redaction or defaulting. Existing pure semantic validation then decides formal,
   finite provisional, unavailable and not-needed outcomes; `workflow: null` keeps today's
   provisional/unavailable meaning, provisional plans stay representable and are never
   promoted. Source-ID rules stay as today: a null objective may have an empty list, a
   non-null objective requires exactly the pinned source, and a pending-Start verdict
   requires exactly the pinned source regardless of the objective. Rejecting a new wire
   shape is an approved protocol change, not a parity claim.
4. **Native authority.** Reuse `findToolEvidence`/`verifyWorkflowToolEvidence`
   (`workflow-write-evidence.ts:45,207-275`) with one new evidence tool kind and its
   direct and MCPX names: the current owned root (never a helper, operative, sibling or
   other root), the exact ready binding and generation, the native provider identity, an
   executed strong main-run `dynamic_tool` item and node, no parent item, nothing rolled
   back or unexecuted, and the complete raw arguments canonically equal to the native
   item. In addition the item's run must be the run whose `userMessageId` is the task's
   persisted interpretation request message and whose request text hash equals the task's;
   a valid call from another run of the same root is insufficient. A running item counts
   for intake, as the verifier already allows. If it is not yet visible within the existing
   400 ms evidence budget the tool returns `pending_proof` with no receipt, and only an
   identical retry is meaningful.
5. **Intake commit (write-once per attempt).** Inside the admission section of 3.11 (the
   intake is a policy-dependent write), after proof and fresh checks of the attempt (the
   task's current attempt, status `dispatching`/`waiting`/`uncertain`), source pin and
   genuine human message (`currentSource`, `:1393-1402`), binding, activation floor, Stop
   and control generations, one `GuidanceDb` transaction CASes the first verified
   submission for that `attemptId` into the existing workflow receipt table
   (CC-WFRECEIPT: owner, binding generation, namespace `interpretation`, operation =
   `attemptId`, request hash = raw-argument hash) with the immutable decoded payload and
   the native proof reference (item, run, node, provider identity). The task record holds
   only a pointer to its current attempt, so a renewal or source edit that spreads the old
   task gets a new attempt and pointer and keeps the old receipt as history. Rules:
   - order of intake: authenticate (bearer, Host/Origin), decode, verify native proof, then
     look up an existing receipt for the `attemptId` **before** the attempt-state gate; an
     identical replay returns its original receipt even after finalization, without
     re-activation or a new send; only without a receipt does the state gate (current
     attempt, `dispatching`/`waiting`/`uncertain`) apply before the commit;
   - a durable receipt whose HTTP response was lost does not make its native evidence usable
     later: finalization re-verifies it (item 7), and a missing or failed original tool
     completion leaves it unapplied;
   - changed content under the same `attemptId` returns `conflict`, and nothing else can
     replace a committed result;
   - a submission for a superseded attempt (a late call from the old run after a renewal
     or source edit) is `stale` and never writes the new attempt;
   - a failed decode or proof reserves nothing; a SQL failure rolls back result, proof and
     receipt together.

   No new table or database, no outbox, no scheduler. Pending Start uses a narrow
   interpretation-submission permission (the exact pinned Start task and source, current
   mode and master generations, no later Stop or Enable), not `authorizeNative`'s effect
   permission and not any workflow or team write privilege. Recording never activates a
   Start.
6. **Prompt return and wake.** The tool returns right after the commit:
   `submitted` (meaning recorded and awaiting native completion; never delivered or
   agreed), `duplicate`, `pending_proof`, `invalid`, `stale`, `denied`, `conflict`,
   `unavailable` or `storage_failed`, all as redacted typed errors (codes and paths only;
   no raw arguments, secrets or pretty-printed Schema causes in logs). It never waits for
   its own run, which cannot finish while the call is open. The commit signals a coalesced
   per-scope wake (`Queue.sliding(1)` owned by the supervision service, not by the MCP
   request scope); until that task's run is terminal the scope rechecks on a short
   `Schedule` (250 ms, bounded by the existing 300 s interpretation limit) instead of the
   5 s spacing. The persisted task state is the record of work; restart and the normal
   cycle recover a lost wake, and the response never blocks on a full queue.
7. **Finalization (existing completed-run gate).** `reconcile` keeps its gate: only a
   successfully completed run of the exact request message finalizes the task's current
   attempt. Before applying the result and before any Start activation it re-verifies the
   full retained proof (item executed, strong, in the same run, node not rolled back, main
   graph and provider identity unchanged, raw-argument hash equal); an item or node rolled
   back while the run itself completed discards the submission. It then refreshes source,
   boundary, definitions, control and binding and applies the recorded result and any Start
   activation inside the admission section, in the existing transaction and policy-file
   ordering (`project-supervisor.ts:670`). The re-verification precedes every application,
   including a bare Start and a no-workflow result; those never enter proposal checks. A completed run without a recorded submission
   closes `unavailable` ("did not submit a valid, source-linked interpretation"); a
   failed, interrupted, cancelled or rolled-back run discards it. Final chat text is
   irrelevant: the final-message `JSON.parse`, fence stripping, string parsers and their
   prompts are deleted (`supervisor-workflow.ts:65,68,411,1467`, the reader interpretation
   instructions and `supervisor-conversation.ts:425`), with no fallback. A bare positive
   Start may activate permission without a substantive workflow; a negative verdict
   activates nothing; shared definitions never activate No Project; On request stays the
   default.
8. **Proposal evidence switches together.** In the same commit series, every reader of
   the interpretation as proposal evidence moves to the submission, including the shared
   `proposalEvidenceCurrent` and `agreementEvidenceCurrent`
   (`supervisor-conversation.ts:1143-1203`, which today require a completed assistant
   message and text hash) and the other readers at `:1535,1801,1810,1822,1956`. Later
   negotiated proposal and operative acceptance records keep their existing protocol and
   parser; only final-chat interpretation parsing is removed.
   `WorkflowAgreementCandidate` provenance (`supervisor-conversation-store.ts:45`) becomes a
   discriminated `evidence`: `interpretation_submission` {taskId, attemptId, itemId,
   runId, argumentsHash, sourcePin, canonical plan digest} for new interpretations, and the
   existing `supervisor_message` {messageId, runId, runOrdinal, textHash} kept for later
   proposals. A candidate-free interpretation (a provisional plan, which today returns
   `"provisional"` at `supervisor-conversation.ts:1832` before any candidate is persisted,
   or a ready/blocked preparation before the first candidate) keeps the same union in one
   existing-record field, `TaskRecord.interpretationEvidence`
   (`project-supervisor-store.ts:40`): the attempt's `interpretation_submission` for new
   interpretations, and `supervisor_message` plus the canonical plan digest only for
   cut-over states (item 11). `interpretationEvidenceCurrent` (`:1810-1819`, used at
   `:1956`) reads that field when no candidate exists, instead of re-parsing the run's
   messages. No tool item ID is stored in an assistant-message field. Evidence is current
   only while the native tool item is still executed, in the same run, not rolled back,
   with an unchanged argument hash; introduction checks, candidate use and agreement
   invalidation use it.
9. **Routing.** The destination is always the task's bound operative main, derived from the
   binding and task. A needed interpretation goes through the existing preparation and
   `sendIntroduction` (pending owner input, steer versus queue, native mode and contact
   restrictions, visibility, durable command and message IDs); a not-needed or no-task
   result sends nothing. Stop, control, source and binding fences apply at finalization and
   again at native admission under CC-STOP-LIN (3.11). An introduction admitted before a
   Stop keeps its exact body, IDs and route and is only observed and reconciled; it is never
   relabelled unsent, rerouted or given fresh IDs, and a tool retry never re-sends it. The
   existing definite-rejection fallback stays distinct from an unknown outcome. Submitting
   or stopping never interrupts the operative.
10. **Agreement boundary.** A submission, receipt, root completion or tool success is
    interpretation and proposal evidence only. Agreement still needs the operative main's
    own completed exact acceptance of the current task, proposal and digest after the real
    introduction.
11. **Cut-over (one-off, evidence-preserving).** At the S6e deployment, in one logged
    startup step that reads native evidence and never sends:
    - **In-flight old-prompt requests** (`dispatching`/`waiting`/`uncertain` with a JSON-only
      request): never rewritten or re-sent under their native IDs, and no typed receipt is
      minted for their final answers. Their native runs are observed read-only; once
      terminal, each attempt closes unapplied with an explicit reason ("interpretation
      protocol changed; a new genuine request is interpreted under the typed protocol").
      Unknown native work stays observable with its IDs. The coordinator schedules the
      cut-over when none are in flight where possible.
    - **Pending Start** waiting on such an attempt is rejected with that reason; the human
      can request again.
    - **Retained initial candidates and accepted agreements** built from final-message
      evidence: each is checked against the still-present native message (same message,
      run and text hash) and, if it matches, converted once to the `supervisor_message`
      evidence variant with its existing IDs and hash; if it no longer matches it is marked
      stale exactly as the baseline would, never deleted. Its currency is afterwards
      checked by hash equality, never by re-parsing.
    - **Unsent introductions** prepared from such candidates keep their state; they are
      sent only if their converted evidence is current, through the normal path.
    - **Candidate-free inferred or provisional tasks and their introductions** (prepared,
      ready, blocked, sent, admitted or unknown; the state that
      `test/supervisor-conversation.test.ts:2482` produces): the step validates their
      legacy evidence once — the completed assistant message of `task.supervisorRunId`
      whose plan equals `task.workflow` under today's rule — and records it in
      `TaskRecord.interpretationEvidence` as `supervisor_message` {messageId, runId,
      runOrdinal, textHash, canonical plan digest, sourcePin}. This one validation runs
      only inside the logged cut-over step, which is deleted with the old parser after the
      deployment; no runtime final-chat branch remains. Afterwards currency is hash and
      digest equality against the still-present native message. Where no valid message
      exists, the evidence is recorded stale and the task keeps the baseline result of a
      changed answer (an unsent introduction blocks with today's "interpretation answer
      changed" reason). Provisional status is preserved: no typed receipt, formal
      candidate or agreement is invented, no old prompt or native ID is rewritten, and no
      parallel store is added. A sent introduction stays sent; an admitted or unknown
      introduction keeps its exact IDs, body and route and only reconciles.
    - Histories, sessions, identities and non-disposable rows are kept; nothing is reset,
      no parallel execution path remains, and every new interpretation requires the tool.
12. **Prompt.** The interpretation request asks the root to make one successful immutable
    submission with the quoted `taskId`, `attemptId` and `sourcePin` (an identical retry
    after a pending or lost response, or a corrected call after `invalid`, is allowed) and
    not to answer with JSON. The
    root must reach the Supervisor MCP tool on both hosts.

Blockers before implementation (S6e):
- **B1.** Both reviewers align on this reconciled design (A-I01..A-I04, SOL-ITOOL-1..8).
- **B2.** Before implementation, the coordinator's early native check shows a running
  `dynamic_tool` item of an existing approved Supervisor tool visible through the direct
  and the MCPX paths actually used, on both hosts. After the S6e candidate exists, a
  bounded initial spike on both hosts shows a running item of this exact new tool on the
  same paths before the typed cut-over is accepted or enabled. No test-only tool, T3
  change, proxy or forced submission is used.
- **B3.** CT-ISUB-01..19 are accepted as the contract.
- **B4.** The coupled suites (`supervisor-workflow.test.ts`, `project-supervisor.test.ts`,
  `project-supervisor-workflow.test.ts`, `supervisor-conversation.test.ts`,
  `supervisor-workflow-agreement.test.ts`, `workflow-write-controller.test.ts`) keep their
  names where the intent survives, with fixtures producing tool items. Any leaf that only
  tested fence or JSON syntax is replaced and listed by name in the S6e ledger (A-01 holds
  through S6d).

Tests (`new-behaviour`, S6e; reuse existing fixtures, real MCP route, controller, native
HTTP/WS peer and guidance SQL):

| ID | Case |
| --- | --- |
| CT-ISUB-01 | valid submission in the exact request run → `submitted` → finalized once on run completion → one introduction to the bound main |
| CT-ISUB-02 | authority: other root, helper, operative, earlier run of the same root, another provider identity, changed raw arguments, weak, truncated, forged or rolled-back item → nothing recorded; direct and MCPX wrappers |
| CT-ISUB-03 | excess keys (including any target/route field), oversize, depth and node limits rejected; Schema normalization cannot hide a raw-argument mismatch |
| CT-ISUB-04 | idempotency: identical concurrent calls, identical replay, conflicting payload under the same `attemptId`, another ID for the same attempt, replay after finalization (receipt lookup before the state gate, no re-activation), lost response then retry, missing or failed original tool completion, identical in-run retry, transaction failure rollback |
| CT-ISUB-05 | invalid inputs return typed diagnostics, reserve nothing, and a corrected resubmission in the same run succeeds |
| CT-ISUB-06 | source edit, new genuine request, definitions change, binding replacement and control change between proof, commit, finalization and send |
| CT-ISUB-07 | pending Start (extending `project-supervisor.test.ts:1581,1608,1642`): true activates after completion, false rejects, missing verdict invalid, mode/master/binding change or later Stop prevents activation, bare Start without a task, a changed or rolled-back tool item before activation prevents it, no widening to general effects |
| CT-ISUB-08 | Stop before submission (denied), after receipt before send (suppressed), at native admission (CC-STOP-LIN); admitted or unknown introduction survives restart with its IDs; Retry never re-sends; definite rejection keeps its own path |
| CT-ISUB-09 | completed run without submission → `unavailable`; well-formed or malformed final-chat JSON and arbitrary final prose are ignored |
| CT-ISUB-10 | failed, interrupted, cancelled or rolled-back run after submission → discarded; an item or node rolled back while the run completes → discarded before apply and before Start activation; unchanged proof → applied; another run's completion does not finalize |
| CT-ISUB-11 | restart after commit and before the wake → finalized exactly once |
| CT-ISUB-12 | greeting and negative Start → no contact |
| CT-ISUB-13 | submission, receipt, root or helper acceptance, plain "yes", completed coding or a changed digest never create agreement |
| CT-ISUB-14 | timestamps or spans per phase: dispatch admitted, model time to tool invocation, submission received, Schema validated, native proof verified, commit, run terminal, finalization, introduction visible, exact operative acceptance |
| CT-ISUB-15 | the tool returns before its run completes; the wake finalizes without waiting for the 5 s spacing |
| CT-ISUB-16 | conversation proposal and agreement evidence follow the recorded tool item end to end (rolled-back or changed item → not current); bare Start and no-workflow results never enter proposal checks; no hidden final-text re-parse |
| CT-ISUB-17 | cut-over: an in-flight JSON-only request closes unapplied after its run ends without a re-send; a pending Start on it is rejected; a retained final-message candidate and accepted agreement stay valid by hash after the one-off conversion, and a mismatching one is marked stale, not deleted; an unsent introduction is sent only with current converted evidence; parameterized with the existing provisional fixture (`supervisor-conversation.test.ts:2482`): a candidate-free inferred/ready state, a sent provisional state and an admitted/unknown introduction keep provisional status and current (or baseline-equivalent stale) evidence, and the unknown introduction keeps exact IDs, body and route and only reconciles; restart after conversion keeps all of them |
| CT-ISUB-18 | logs and spans for every typed error carry codes and paths only, never raw arguments or secret-shaped values |
| CT-ISUB-19 | attempts: a source edit and an approved-definitions renewal of the same task ID, each with a late submission from the old run (`stale`, writes nothing), a duplicate after apply (original receipt), a successful current-run submission, and exactly one introduction |

CT-INT-01 gains the same tool through the authenticated route after S6e.

**Other model-to-service structured results (ANDREA-ITOOL-EVAL-01, evaluation only).**
Andrea approved exactly one new tool; both reviewers' evaluations agree. "Keep" means the
existing typed path stays and is migrated to Effect `Schema` with the rest of the plan.

| Contract (producer → reader) | Existing typed path | Demonstrated failure or risk | Recommendation |
| --- | --- | --- | --- |
| Initial interpretation incl. pending-Start verdict | none: final-chat JSON | demonstrated: missing final brace (Luna HIGH, Luna MAX, Sol 6.1 LOW), stale CSV content (Luna HIGH, Luna MAX); failed closed | **needed — approved**: `supervision_interpretation_submit` (this section) |
| Initial routing and delivery | existing durable introduction and dispatcher; `supervision_guide` for child guidance | model-chosen targets would widen authority | **unnecessary**: no dispatch tool |
| Workflow proposals and operative acceptance (fenced records, `supervisor-workflow-agreement.ts:40-76`) | none for the records; `workflow_read` check, `workflow_write` for state | not demonstrated (negotiation never reached); malformed records surface as `record_json_invalid` | **possible future gap**: only a separately approved contract on post-S6e negotiation evidence, preserving operative-own-run acceptance after the introduction; nothing now |
| Definition change authorization (`supervisor-conversation.ts:713-749`) | Supervisor decision records plus genuine human evidence, or the editor save | not demonstrated; malformed fences leave the decision pending | **keep** |
| Operative external contribution report and root assessment | completed `external-contribution` record; `workflow_write` `assess_contribution` | not demonstrated | **keep** |
| Workflow status, plan and assessment | `workflow_write` (`apply`, `ensure_main`, `link_child`, `assess_contribution`) | none | **keep** |
| Helper readiness, reports, assignment, handover | `supervision_team` with epochs and receipts | none | **keep** |
| Root and helper check-in completion, frozen-batch ACK | exact completion marker on a completed own run; transactional ACK | a missing marker stalls safely | **keep** |
| Start and Stop | `supervision_start` / `supervision_stop` with native proof | none (pilot: Start and Stop succeeded) | **keep** |
| Activity monitoring | native observation, not a model result | none | **unnecessary** |

None of the other rows blocks the migration, and no other result is folded into the
interpretation tool.

**Model comparison (ANDREA-MODEL-01, coordinator evidence; D-28).** Observations on the
same retained root and owned fixture, sequential trials, no coaching, global and project
defaults unchanged, Luna HIGH labelled separately; single samples, so individual values
only:

| Trial | Luna HIGH | Luna MAX | Sol 6.1 LOW |
| --- | --- | --- | --- |
| Bare Start (root latency) | 9.114 s, passed | 5.713 s, passed | 7.777 s, passed |
| Greeting | 16.509 s; stale CSV, malformed JSON; failed closed | 19.554 s; stale CSV, malformed JSON; failed closed | 3.019 s; correct `not_needed` |
| Coding plan | malformed JSON; failed closed | 13.659 s; stale CSV, malformed JSON; failed closed | 17.576 s; malformed JSON, no stale CSV; failed closed |
| Genuine Stop and settlement | passed | passed | passed |

No successful negotiation has been observed yet, so nothing here decides a default. Only the
owned fixture root's model was changed for these trials and has been restored; global and
project defaults were never changed. After
S6e the coordinator repeats the comparison on the same frozen build and the typed protocol,
with comparable uncoached requests and an explicit budget, recording per trial the native
provider, model and effective options read back, fixture, root, run and source IDs, context
and trial order. Phases are measured separately: source intake → interpretation dispatch →
model time to tool invocation → validation and commit → native run terminal →
finalization → introduction visible → exact operative acceptance; monotonic time for
local phases and one native clock domain for native milestones, never subtracting
unrelated host clocks. Success rate is reported before latency, with failed, unavailable
and censored outcomes kept in the denominator; coding, npm and build time are excluded.
Old final-JSON trials are not pooled with typed-tool trials. Semantic correctness (no
resurrected request, correct verdict) is judged separately from schema validity. Sol 6.1
LOW becomes the default only if it shows equal or better correctness on every case and
lower interpretation and negotiation latency than Luna MAX; until then models, defaults and
settings stay unchanged.

## 4. Cross-file contract map

Full invariants, participants (derived from manifest rows, each row tagged) and pins are in
`effect-v4-files.json` under `contracts`; `CC-STOP-LIN` also carries the 18-path table and
the policy commit list.

| ID | Owner | Slice | Invariant (first clause; full text in the manifest) | Pins |
| --- | --- | --- | --- | --- |
| CC-AUTH | `src/service-auth.ts` | S6c | login.sqlite3 journal_mode DELETE, exactly two STRICT tables, caps of 32 grants/sessions, grant consume + session insert in one BEGIN IMMEDIATE, O_NOFOLLOW + dev/ino identity checks, fchmod 0600/0700, link()-based … | service-auth.test.ts, auth-cli.test.ts, CT-AUTH-01..04, CT-AUTH-05 |
| CC-BINDING-GEN | `src/project-supervisor-contract.ts` | S7 | UI and API results are applied only to the exact project/main/binding generation that requested them. | CT-UI-PS-02, project-supervisor-ui tests |
| CC-BINDING-MERGE | `src/project-supervisor-store.ts` | S6d | stale full-document binding writes keep the stored stopNotice/supervisionStop | CT-LIFE-02 |
| CC-CATALOG | `src/store.ts` | S3 | Store service shape unchanged | store.test.ts, t3 watch tests, CT-STORE-01..03 |
| CC-CLI | `src/cli.ts` | S6c | commands start and auth forge with --data-dir | auth-cli.test.ts, CT-CLI-01, CT-CLI-02, CT-CLI-03, CT-CLI-04, CT-CLI-BIN-01, CT-CLI-BIN-02, CT-CLI-BIN-03 |
| CC-CLOCK-ELAPSED | `cross-cutting` | S2 | in-memory budgets and deadlines use monotonic time (Clock.monotonicTimeNanos or Effect.timeout/sleep) | CT-CLOCK-01, t3-projection-stream.test.ts deadlines |
| CC-CLOCK-WALL | `cross-cutting` | S2 | persisted timestamps, TTLs, cooldowns compared across restarts and session expiry use wall Clock.currentTimeMillis where the baseline used Date.now | per-slice TestClock tests, service-auth TTL tests |
| CC-CONFIG | `src/types.ts` | S2 | same env names, defaults and validation (invalid_helper_provider_instance_id) | config.test.ts, CT-CONFIG-01..03 |
| CC-CONTROL | `src/project-supervisor-store.ts` | S6d | every control has its own generation CAS (master, project, No Project, global definitions) | No Project defaults to On request and shared definitions never activate a chat, supervisor-control.test.ts |
| CC-DBFILES | `cross-cutting` | S3 | per-file journal mode and pragmas exactly as today (catalog/guidance/thread-settings WAL + listed pragmas | CT-FILES-MODE-01, CT-AUTH-01..04, per-DB pragma tests |
| CC-DEFS | `src/project-definitions.ts` | S5 | definitions revision = sha256 of [projectId, threadId, root, scratch, inputs], set only when complete | CT-PD-03 |
| CC-FILEMODES | `src/store.ts` | S3 | data dir 0700, database files 0600 including -wal/-shm (catalog chmods on open/commit/close | CT-FILES-MODE-01 |
| CC-FILES | `src/project-files.ts` | S4 | writer failures after send -> unavailable mapped to uncertain by the editor, never retried | project-committer.test.ts, project-config-editor.test.ts, CT-FILES-01..03, CT-EDITOR-01..02 |
| CC-GDB | `src/guidance-store.ts` | S6d | guidance.sqlite3 is served by exactly one connection | CT-GDB-01..06, CT-PSS-08, CT-WSS-01, CT-WWC-04, CT-CONV-04, CT-MSTORE-01, CT-TRUN-03, CT-TCTRL-03 |
| CC-GDB-IMPLICIT | `src/guidance-store.ts` | S6d | multi-statement read-modify-write sequences without a transaction are atomic today only because synchronous JS runs to completion (guidance-store observe/reserveTokens/prune/resolveEpisode, conversation-store … | CT-CSTORE-02, CT-TSTORE-01, CT-TSTORE-02, CT-MSTORE-02, CT-TRUN-02, CT-PSS-08, CT-PROBE-01..03 |
| CC-HEALTH | `src/supervisor.ts` | S2 | 0.0.0.0:HEALTH_PORT, exact /health and /live paths (query string -> 404 empty), body {ok, readiness, ...status}, 200/503, any method | CT-HEALTH-01 |
| CC-HELPER-RECEIPT | `src/supervisor-helper-transport.ts` | S6a | exact sent bytes and write-once rendering/message id/contradiction in supervisor_helper_deliveries | helper-transport tests, CT-HTX-01..04 |
| CC-HTTPAPI | `src/guidance-contract.ts` | S6c | SupervisorApi endpoints, payload/response Schemas and error encodings stay wire-identical for server (guidance-ui.ts) and client (ui/src/api.ts AtomHttpApi). | CT-UI-01..08, CT-UI-API-01 |
| CC-IDS | `src/supervisor-conversation-store.ts` | S6d | persisted identity formats (supervisor-review:<id>, supervisor-notice:workflow:<taskId>, supervisor-objective:<taskId>, supervisor-create:<thread>:<generation>, supervisor-settle:<uuid>, … | CT-SW-01, golden id tests per store |
| CC-INTERP | `src/project-supervisor.ts` | S6b | interpretation command persisted 'dispatching' before RPC | project-supervisor.test.ts L770-L964, CT-PS-01, CT-PS-02 |
| CC-INTERP-SUBMIT | `src/project-supervisor.ts` | S6e | interpretation results arrive only through supervision_interpretation_submit | CT-ISUB-01, CT-ISUB-02, CT-ISUB-03, CT-ISUB-04, CT-ISUB-05, CT-ISUB-06, CT-ISUB-07, CT-ISUB-08 |
| CC-MCP | `src/workflow-mcp.ts` | S6c | stateless Streamable HTTP at /mcp/workflows (no Mcp-Session-Id), JSON responses, 1 MiB body, 9 s per call, abort on client close, tool list order, isError reasons | workflow-mcp.test.ts, CT-MCP-01..05, CT-WWC-06 |
| CC-MONITOR-ACK | `src/supervisor-monitor-store.ts` | S6d | frozen activity batches are acknowledged only at their exact version inside the caller's transaction. | monitor L637/L657/L1012, conversation L1799, team-runtime L739/L974 |
| CC-NATIVE | `src/supervisor-native.ts` | S4 | outcome classification: before send -> rejected (not definite) | supervisor-native.test.ts 1-8, CT-NATIVE-01..04 |
| CC-NESTTX | `src/supervisor-team-store.ts` | S6d | join-if-in-transaction else open (db.isTransaction) and caller-owned *InTransaction APIs become nested withTransaction (SAVEPOINT/RELEASE) | CT-TCTRL-03 |
| CC-NOPROJECT-DEFAULT | `src/project-supervisor-store.ts` | S6d | On request remains the No Project default in store, API and UI presentation | no-project-ui.test.ts, project-supervisor.test.ts L1568 |
| CC-OVERVIEW-RANGE | `src/dashboard-overview.ts` | S7 | readOverviewRange pages by 100 and keeps the previous read on failure. | dashboard-overview.test.ts, CT-UI-OVERVIEW-01 |
| CC-OWNED | `src/supervisor-team-store.ts` | S6d | registerMember must not add an owned id before the outermost commit (latent phantom id on rollback today) | CT-TCTRL-03 |
| CC-OWNERSHIP | `src/project-supervisor-store.ts` | S6d | owned Supervisor thread ids are loaded before catalog filtering | supervisor-ownership.test.ts, CT-PSS-05 |
| CC-PROBE | `src/git-probe.ts` | S4 | pending {threadId, terminalId} persisted before terminal.open, removed only after successful terminal.close | git-probe.test.ts, CT-PROBE-01..03 |
| CC-PROOF | `src/workflow-write-evidence.ts` | S6a | native authority: exact own-main-run dynamic_tool item with canonically equal arguments | workflow-write-controller.test.ts L372-L683, CT-WWE-01 |
| CC-RECEIPT-FIRST | `src/supervisor-conversation.ts` | S6b | a durable sending/posting/uncertain/prepared record with the final native identity is committed before the native effect | CT-CONV-01..03, CT-TRUN-01, CT-HTX-01, CT-LIFE-01, CT-TCTRL-01, CT-PS-01, CT-PS-02 |
| CC-RECOVERY | `src/guidance-store.ts` | S6d | on open: notices committed -> not_delivered_restart (dispatch_started=0) or uncertain (=1) with one process_recovery activity each | CT-GDB-01, team-store L290 |
| CC-REDACT | `src/credential-redaction.ts` | S2 | no credential, token, cookie or Authorization value, native error body, capability URL (webhook path) or raw cause in logs, spans, errors or HTTP bodies | t3.test.ts 4/14, team-controller L186, CT-CLI-05, CT-REDACT-01 |
| CC-SCOPE-SERIAL | `src/project-supervisor.ts` | S6b | run/reconcile/check of one Supervisor scope never overlap (serial(scopeKey)) | CT-PS-03, CT-PS-05 |
| CC-SETUP-FENCE | `ui/src/supervisor-control.tsx` | S7 | supervision setup fence latches on uncertainty and blocks other control changes until a verified read. | supervision-controls-ui.test.ts |
| CC-SHUTDOWN | `src/main.ts` | S2 | SIGINT/SIGTERM interrupt the main fiber | CT-MAIN-01..03 |
| CC-SQL-LIFETIME | `cross-cutting` | S3 | four named interfaces CatalogDb/GuidanceDb/PolicyDb/AccessDb | CT-SQL-01, CT-SQL-02, CT-SQL-03, CT-SQL-04, CT-AUTH-05 |
| CC-START | `src/project-supervisor.ts` | S6b | one receipt per (thread, operationId) with requestHash | project-supervisor.test.ts L1568-L1786, CT-PS-04, CT-PSS-01 |
| CC-START-FENCE | `ui/src/no-project.tsx` | S7 | a retained browser Start intent (threadId, operationId) blocks new Starts until a terminal status | CT-UI-START-01 |
| CC-STATUS | `src/supervisor.ts` | S2 | status written by 4 fibers | supervisor.test.ts, CT-HEALTH-01 |
| CC-STOP | `src/project-supervisor.ts` | S6b | a per-chat human Stop fences every new send | CT-PS-07, CT-PS-09, CT-PSS-03, conversation L4229-L5029, team-runtime L189/L1886/L1923, CT-LIN-01, CT-LIN-03, CT-LIN-06 |
| CC-STOP-LIN | `src/project-supervisor.ts` | S6a | policy reads stay authoritative database reads (no snapshot) | CT-LIN-01, CT-LIN-02, CT-LIN-03, CT-LIN-04, CT-LIN-05, CT-LIN-06, CT-LIN-07, CT-LIN-08 |
| CC-SYNC-ATOMIC | `cross-cutting` | S4–S6c | every baseline synchronous block (DB or in-memory read-check-write) maps to one Effect.sync section, Ref.modify, SynchronizedRef or Semaphore-guarded section | s1-baseline characterizations per controller, target-regression forced-yield variants after each port |
| CC-T3RPC | `src/t3.ts` | S4 | native T3 RPC frames are the effect/rpc RpcMessage protocol (Request/Ack/Ping/Pong/Chunk/Exit) | t3.test.ts, CT-T3-01..05, CT-WSFRAME-01 |
| CC-TEAM-EPOCH | `src/supervisor-team-store.ts` | S6d | member epoch + assignment epoch + coverage CAS on every helper write, request, assessment, notice and guide | supervisor-team-store.test.ts, team-controller L218, team-runtime L1589/L1681/L1700 |
| CC-UI-DRAFTS | `ui/src/main.tsx` | S7 | drafts survive reloads, session expiry and re-sign-in | CT-UI-SHELL-01, CT-UI-PS-01 |
| CC-UI-MUTATION | `ui/src/api.ts` | S7 | queries keyed by the full scope tuple cancel on change | UI-STORY-03, UI-STORY-07, CT-UI-START-01, CT-UI-SETUP-01, CT-UI-EDITOR-01 |
| CC-UI-SESSION | `ui/src/access.ts` | S7 | session token only in localStorage | browser-access.test.ts, CT-UI-AUTH-01 |
| CC-WEBSEC | `src/guidance-ui.ts` | S6c | exact Host/Origin/CSRF/session check order, JSON {message} bodies, security headers | guidance.test.ts, project-config-editor.test.ts #5, CT-UI-01..08 |
| CC-WFCAS | `src/workflow-state-store.ts` | S6d | UPDATE ... AND revision=? with changes===1 and the receipt in the same transaction | workflow-state.test.ts L269, CT-WSS-01, CT-WSS-02 |
| CC-WFPLAN | `src/supervisor-workflow.ts` | S6a | canonicalJson, fingerprint (sha256 of JSON.stringify), seeded node ids, compactProposalDigest and stateHash are persisted identities and stay byte-identical. | CT-SW-01, CT-SWA-01, CT-WSS-04 |
| CC-WFRECEIPT | `src/workflow-write-controller.ts` | S6b | workflow write receipts keyed by owner, generation, namespace, operationId, requestHash | workflow-write-controller.test.ts L343-L1769, CT-WWC-02, CT-WWC-05, CT-WSS-03 |
| CC-WSFRAME | `src/t3.ts` | S4 | one shared envelope implementation replaces the 6 hand-written copies (t3.ts, supervisor-native.ts, git-probe.ts, project-files.ts x3) without changing frames, limits, close or error handling (decisions D-08/D-09). | CT-WSFRAME-01 |

## 5. Test plan

### 5.1 Test phases and gates (A-P04, SOL-PLAN-04)

Every proposed test in the manifest registry (`characterizationTests`) records `phase`,
`baselineSeam`, `expectedBaseline`, `targetSeam`, `slice`, and either `reuses` (the closest
existing test, file and title) or `newObservation` (the uncovered delta in one line).
Phases:

| Phase | Runs on | Meaning |
| --- | --- | --- |
| `s0-parity` | S0 | the 863 existing leaves and 6 groups, mechanically converted to Vitest on the baseline application dependencies (effect 4.0.1) |
| `s1c-transition-golden` | recorded in S1 on baseline dependencies, rerun unchanged after the S1c bump | exact wire/Schema/HTTP outputs that the 4.0.5 dependency change could alter |
| `s1-baseline` | S1, unchanged source | characterizations with present seams: concurrent calls, real abort, real sockets and HTTP peers, child processes, process kill, real SQLite files |
| `known-failure` | S1b | red on baseline; the red run is recorded as evidence and the test is committed only together with a separately reviewed minimal fix (CT-TCTRL-03, D-21) |
| `target-regression` | owning slice, after the port | needs ported APIs: forced fiber yields, Effect interruption, `SqlClient`, `TestClock`, Atom registries; never presented as baseline proof |
| `new-behaviour` | S6e | authorized new behaviour (typed interpretation submission, 3.12); no baseline equivalent exists |

Rules: every `s1-baseline` test passes on unchanged code before any port. No `.skip`,
`.todo`, `.only`, `.fails`, expected-failure inversion or weakened assertion is used to pass
a gate. All 863 existing leaves and their assertions stay; renames are ledger entries.
Overlapping proposals are consolidated under one ID referenced by several files and
contracts (O-01); distinct controller and store checks stay separate only when they prove
different guarantees. The test count is not a target; unchanged pure helpers already
proven by golden controller/native tests get no new isolated suite (O-02).

### 5.2 Harness conversion and parity (S0/S1c)

- **S0 (Vitest only, baseline dependencies).** `vitest` 5.0.5 is the only dependency
  change; `effect` stays 4.0.1 and `@effect/vitest` is not added yet. Root
  `vitest.config.ts` (`include: ["test/**/*.test.ts"]`, node environment,
  `pool: "forks"`, file isolation like `tsx --test`). Mechanical conversion: `test(...)` →
  `it(...)`; each of the 6 `t.test` groups → a `describe` with the same name whose 20 cases
  keep setup, cleanup and assertions (loop-generated cases stay loop-generated);
  `t.after` → `onTestFinished`; `t.mock.method(Date, "now")` → `vi.spyOn` until the owning
  slice moves time to `Clock`. `node:assert/strict` stays until the owning slice converts
  the suite to `@effect/vitest`. `tsx` stays a dev dependency (child processes and worker
  threads use `--import tsx`).
- **Parity gate.** The baseline map (`baseline.tests`: 843 top-level leaves + 6 named groups
  holding 20 subtests = 863 leaves, 869 Node results) is compared with Vitest's JSON
  reporter by file, full name and order: 863/863 leaves and 6/6 groups identical and
  passing.
- **S1c (exact 4.0.5 transition, after S1).** `effect` and every companion move to exactly
  4.0.5 and `@effect/vitest` 4.0.5 is added. Because S1 runs first on the baseline
  dependencies, every S1 characterization and the `s1c-transition-golden` outputs are rerun
  unchanged on 4.0.5 as the transition proof; parity stays 863/863.
- **Real boundaries stay real**: temp-file SQLite, real `ws`/HTTP fake T3 servers, real
  child processes for the CLI and worker-thread contention. A mock never replaces an
  existing integration test.
- **Token hygiene**: tests that forge or read tokens capture child output and assert the
  token appears only on `auth forge` stdout; failure messages print lengths or hashes.

### 5.3 Runner bounds (D-05; A-P05)

Evidence: Sol's probe (`/tmp/sol-effect-v4-phase1/harness-probe`), the owner's reproduction
(`/tmp/effv4-probe`) and Astra's probe (`harness-probe/*results.json`), all on Vitest 5.0.5
and `@effect/vitest` 4.0.5:

| Case | Exit | Result |
| --- | --- | --- |
| `setInterval` leak, `detectAsyncLeaks` only | 0 | leak reported, run passes |
| same leak + leak-gate reporter | 1 | `leak-gate: 1 async leak(s)` |
| clean test + leak gate | 0 | no leak |
| `it.effect` + `Effect.never` + `{timeout: 100}` | 1 | interrupted, finalizer ran |
| `it.live` + in-effect `Effect.timeout("50 millis")` | pass | typed failure, finalizer ran |
| unbounded Promise deadlock, `testTimeout: 0` | 124 / 143 | outer watchdog killed the process group (owner 4 s, Astra 6 s; 143 is the raw TERM exit) |
| synchronously blocked worker, `testTimeout: 0` | 143 | outer watchdog killed the group after start markers (Astra) |

Vitest 5.0.5 treats `detectAsyncLeaks` as reporting only (`state.leakSet`,
`vitest/dist/chunks/cli-api.De07GUeT.js:10832-10871`); `timeout <= 0` disables per-test
timeouts (`run.BPv-BBRv.js:3270-3271`). Policy:

1. **S0 only:** `testTimeout: 0` and `hookTimeout: 0`, because the Vitest default (5 s)
   would fail passing baseline tests (5 to 6 cases take 5.7–30 s; 45 take over 2 s). Every
   explicit deadline stays as written (for example `AbortSignal.timeout(5000)` in git-probe,
   projection-stream and config-editor tests).
2. **From S1c, finite bounds for every suite** (new S1 tests carry the same bounds as
   explicit per-test options from the start): Vitest's own `testTimeout` of 10 s for every
   test in both phases; the 55 slow baseline tests from the S0 timing report (every case
   that took over 2 s on either the owner's or Astra's run) carry an explicit per-test
   `{ timeout: 60_000 }` at their definition, so no other test inherits the slower bound
   (SOL-R9-01); `hookTimeout` and `teardownTimeout` 30 s. The values are
   finalized from S0 evidence in the S1c commit. Tighter product and test deadlines stay,
   including projection-stream 5000 ms. After a failure, no retry, no timeout increase and
   no re-run is used to obtain green; a timeout change is a ledger item with evidence.
3. **Leak gate:** `detectAsyncLeaks: true` plus `test/support/leak-gate.ts`, a reporter
   that fails the run on any leak not in the baseline allowlist. It reads
   `vitest.state.leakSet`, an internal field, acceptable only because Vitest is pinned
   exactly; it fails closed if the field is missing. Each allowlist entry names the
   resource kind, the creating source location, the test file, a maximum count and the
   removing slice (not a fungible per-file count). S8 requires an empty allowlist.
   Two refinements, both with harness self-tests: test workers run with `--expose-gc` and
   collect once after each file before the scan, because Node emits `destroy` for an
   unreachable `AsyncResource` (the context Effect keeps for a suspended fiber) only after
   garbage collection; a still-referenced suspended fiber stays reported. **Exception
   (GATE-CPU, coordinator-approved):** Vitest 5.0.5 applies `detectAsyncLeaks` globally
   (`index.1TqnEahn.js:4101`), and its per-promise hook slowed the unchanged CPU-bound
   deadline tests of `test/t3-projection-stream.test.ts` (0.6 s without the hook, 10–56 s
   with it, against the product 5 s bound) and two of `test/t3.test.ts` (the 25 ms
   `httpTimeoutMs` re-read and the 32 MiB default-budget read). These two files run in a
   separate `vitest.cpu-bound.config.ts` phase (`npm test` runs the main and cpu-bound
   phases in one watchdog run, rule 4) without that hook; every assertion and explicit deadline is
   unchanged. Their compensating gate, `test/support/handle-gate.ts`, fails a file that
   leaves any native resource open (timers, immediates, sockets, servers, requests; net
   count per kind against the file's start, after two loop turns so already closed handles
   finish) and fails closed without `process.getActiveResourcesInfo`; self-tests prove a
   leaked interval and an open server fail and a closed server passes. It does **not** see
   pending promises or Effect fibers: the code these files exercise (`src/t3.ts`,
   `src/t3-projection-stream.ts`) starts no fibers, and their own abort, timeout and
   cleanup assertions (aborted and timed-out reads, unread bodies, closed servers) remain
   the evidence for promise settlement. When the owning slice ports these modules (S4),
   their Effect tests return to the full detector or record why not.
4. **Outer watchdog (tooling adapter, O-03).** `npm test` runs `scripts/run-tests.ts` once, an
   Effect program (`effect/process` `ChildProcess` with `NodeChildProcessSpawner`) that runs
   the declared phases in order (`--watchdog-phase=main:vitest.config.ts` and
   `--watchdog-phase=cpu-bound:vitest.cpu-bound.config.ts`), each `vitest run` in its own
   process group, under one 20-minute whole-run deadline (about 6× the 196 s baseline): a
   later phase gets only the remainder, and on expiry the active group gets TERM, then KILL
   after 10 s, no later phase starts and the run exits 124. A failing phase stops the run
   with its exit code; signals are forwarded to the active group (128 + n). Caller
   arguments are parsed once with Vitest's own parser: `--config` runs that configuration
   once with them; file filters and the selection options (`--exclude`, `--dir`, `--root`,
   `--changed`) select phases by Vitest's own matching (`vitest list --filesOnly` with the
   same options), a location filter goes only to the phase owning its file, and a selection
   no phase matches or a location no selected phase owns fails as Vitest does; over several
   phases each report goes to its own `<name>.<phase>.<ext>` file resolved against the
   effective root, earlier reports at those paths are removed first, and `--reporter=json`
   combines this run's reports into the requested file with a per-phase status, also after
   an expiry or a signal; a completed phase without its report fails the run. CI adds `timeout-minutes: 30`. It is deliberately a separate process
   independent of the tested runtime; it is the emergency backstop, not the normal test
   bound (rule 2 is).
5. **Self-tests:** `npm run test:harness` (separate config, excluded from parity, run in
   CI) proves on every change that a deliberate leak fails the gate; a never-resolving
   Promise and a never-resolving Effect fail at their per-test timeout; a synchronously
   blocked worker is killed by the watchdog with a nonzero exit; a hanging finalizer and a
   failing finalizer are bounded by the teardown timeout and reported; and an Effect
   per-test timeout interrupts the fiber and runs its finalizers (from S1c, with
   `@effect/vitest`).
6. **Ported tests:** `it.effect` (`TestClock`) for policy timing; `it.live` for real
   sockets, processes, HTTP and SQLite with explicit in-effect deadlines and asserted
   finalizers. `TestClock` never stands in for socket, process, browser or native wire
   delivery.

### 5.4 Characterization wave and target tests

The registry holds 205 entries: the 157 v1 IDs (phased by W5 from the baseline code) plus 48
new ones (CT-INT, CT-LIN, CT-SQL, CT-AUTH-05, CT-CLI-BIN, CT-PROBE-T3, CT-CLOCK-01,
CT-REDACT-01, CT-UI-EDITOR-01, CT-UI-SETUP-01, CT-UI-FIXTURE-01, CT-ISUB-01..19).
Dispositions: 188 keep, 7 consolidated into another ID, 7 covered by an existing test, 3
retired by D-26 (CT-GDB-03, CT-GDB-04, CT-GDB-05). Phases: 156 `s1-baseline`, 7 `s0-parity`,
17 `target-regression`, 19 `new-behaviour`, 4 `s1c-transition-golden`, 2 `known-failure`. 80
kept cases also carry a separate post-port `targetRegression` variant.

**S1 (`s1-baseline`, 150 kept cases, unchanged source, baseline dependencies):**

| Kind | IDs |
| --- | --- |
| atomicity-restart | CT-AUTH-01, CT-AUTH-05, CT-CONV-04, CT-CSTORE-03, CT-GDB-01..02, CT-MSTORE-01, CT-PS-02, CT-PS-07, CT-PSS-01, CT-PSS-04, CT-PSS-07..08, CT-RESET-01, CT-STORE-01..02, CT-TRUN-03, CT-WSS-01, CT-WSS-03, CT-WWC-04..05 |
| characterization | CT-APP-01, CT-APP-03, CT-AUTH-02, CT-AUTH-04, CT-CONFIG-01..03, CT-CONV-08..09, CT-CSTORE-04, CT-FILES-02, CT-GDB-06, CT-HEALTH-01, CT-HTX-04, CT-LIFE-03, CT-MAIN-03..04, CT-MCP-02, CT-MCP-04..05, CT-NATIVE-03, CT-PD-03, CT-POLICY-02, CT-PROBE-T3-01..02, CT-PROBE-T3-05, CT-PS-10, CT-PSS-03, CT-PSS-05..06, CT-REDACT-01, CT-STORE-03, CT-SW-01, CT-SWA-01, CT-T3-04..05, CT-TCTRL-05, CT-TRUN-04, CT-UI-04, CT-UI-06..07, CT-WP-02, CT-WSC-01, CT-WSFRAME-01, CT-WSS-04, CT-WWC-06 |
| cli | CT-CLI-01..04, CT-CLI-BIN-01 |
| interruption | CT-CLI-BIN-02..03, CT-CONV-01..03, CT-EDITOR-02, CT-HTX-01, CT-LIFE-01, CT-MAIN-01, CT-MAIN-05, CT-MCP-03, CT-PD-02, CT-PD-04, CT-PROBE-02, CT-PROBE-T3-03, CT-PS-09, CT-T3-03, CT-T3-06, CT-TCTRL-01, CT-TRUN-01, CT-UI-05, CT-WWC-01 |
| native-authority | CT-INT-01..02, CT-MCP-01, CT-TCTRL-04, CT-WWC-08, CT-WWE-01 |
| no-contact | CT-CONV-07, CT-PROBE-T3-04, CT-PS-08, CT-TRUN-05 |
| race | CT-CONV-06, CT-EDITOR-01, CT-LIFE-02, CT-LIN-01..04, CT-LIN-06, CT-PD-01, CT-POLICY-01, CT-PROBE-03, CT-PS-03..05, CT-T3-01, CT-TCTRL-02, CT-TRUN-02, CT-UI-PS-02, CT-UI-SETUP-01, CT-WP-01, CT-WSS-02, CT-WWC-02 |
| resource | CT-APP-02, CT-FILES-MODE-01, CT-HTX-03, CT-PS-11, CT-T3-02, CT-UI-FIXTURE-01 |
| ui-draft-auth | CT-AUTH-03, CT-PSC-02, CT-UI-01..03, CT-UI-AUTH-01, CT-UI-EDITOR-01, CT-UI-NOPROJ-01, CT-UI-OVERVIEW-01, CT-UI-PS-01, CT-UI-SHELL-01, CT-UI-START-01 |
| unknown-send | CT-CSTORE-01, CT-FILES-01, CT-INT-03, CT-NATIVE-01..02, CT-PS-01 |

Present seams only: real abort controllers, crash fakes plus a new controller on the same
file, real sockets and HTTP peers, child processes and process kill, temp-file SQLite, and
(for modules that are already Effect code at baseline: `runSupervisor`, `t3.ts`, `store.ts`,
`guidance-application.ts`, the HttpApi server) `Fiber.interrupt` and `TestClock` from effect
4.0.1. UI cases whose logic lives in component state use the coordinator's mounted stories
as baseline evidence (`baselineEvidence`). Where the v1 wording said a row "stays
sending/prepared/dispatching" after an abort, the baseline catch blocks rewrite it; those
cases record both an abort-honouring and a process-crash variant (CT-CONV-01/02,
CT-TCTRL-01, CT-TRUN-01, CT-LIFE-01, CT-PS-01), and Effect interruption is a
target-regression variant.

**S1b (`known-failure`):** CT-TCTRL-03 (absorbs CT-TSTORE-03). The rows roll back, but
`ProjectSupervisorStore.ownedIds` keeps the helper (`supervisor-team-store.ts:179-181, 343,
359`). The red run is recorded, then the separately reviewed minimal D-21 fix lands with the
test.

**`s1c-transition-golden`:** CT-PDC-01, CT-PSC-01, CT-UI-08, CT-UI-API-01 (recorded in S1,
rerun unchanged after the 4.0.5 bump).

**`target-regression` (after the owning port):** CT-CLOCK-01 (S4, S6b), CT-CSTORE-02 (S6d),
CT-LIN-05 (S6a, S6b), CT-LIN-07 (S6d), CT-LIN-08 (S6a (Start activation), S6b, S6e (typed
intake and finalization)), CT-MAIN-02 (S2), CT-MSTORE-02 (S6d), CT-PSS-02 (S6d), CT-SQL-01
(S3 (CatalogDb), S6c (AccessDb), S6d (GuidanceDb, PolicyDb)), CT-SQL-02 (S3 (CatalogDb), S6c
(AccessDb), S6d (GuidanceDb, PolicyDb)), CT-SQL-03 (S3 (CatalogDb), S6c (AccessDb), S6d
(GuidanceDb, PolicyDb)), CT-SQL-04 (S3 (CatalogDb), S6c (AccessDb), S6d (GuidanceDb,
PolicyDb)), CT-TSTORE-01 (S6d), CT-TSTORE-02 (S6d), CT-WWC-07 (S6b).

**Consolidated (O-01):** CT-CONV-05 → CT-CSTORE-01; CT-HTX-02 → CT-TRUN-02; CT-NATIVE-04 →
CT-NATIVE-02; CT-PDC-01 → CT-UI-08; CT-PS-06 → CT-PSS-01; CT-TSTORE-03 → CT-TCTRL-03;
CT-WWC-03 → CT-WSS-02. Kept apart because they prove different guarantees:
CT-WSS-03/CT-WWC-05, CT-PSS-03/CT-LIFE-02, CT-HTX-01/CT-TRUN-01, CT-CSTORE-03/CT-CONV-01,
CT-WWC-02 (proof/receipt concurrency) versus CT-WSS-02 (store CAS).

**Covered by existing tests (O-02):** CT-CLI-05 (direct installations find the user state
from any directory and support an explicit instance); CT-FILES-03 (native Git operation
inspection follows a worktree .git pointer with existing T3 read RPCs); CT-PROBE-01 (startup
cleanup closes pending probe sessions from the private metadata table); CT-PURE-01 (strict
workflow records ignore object key order while preserving values and array order);
CT-PURE-02 (redaction is stable while source identities and paths remain exact);
CT-TSTORE-04 (test/supervisor-team-store.test.ts (23 supervisor_team_* code assertions, e.g.
'quarantine fences a present helper, preserves uncertain handovers and guide effects, then
permits retirement' :174)); CT-TVIEW-01 (deferred owner guidance raises one stable attention
after grace and routes only after resolution).

**Expectations corrected from the baseline code** (registry `clarification`): CT-APP-01,
CT-APP-02, CT-CONFIG-03, CT-CONV-01, CT-CONV-02, CT-CONV-04, CT-CONV-08, CT-FILES-MODE-01,
CT-GDB-01, CT-GDB-02, CT-HEALTH-01, CT-LIFE-01, CT-MAIN-03, CT-MCP-03, CT-NATIVE-01,
CT-PS-01, CT-PS-07, CT-PS-09, CT-PS-10, CT-STORE-03, CT-T3-02, CT-T3-04, CT-TCTRL-01,
CT-TCTRL-03, CT-TRUN-01, CT-WSC-01. Notably CT-PS-07 (a policy-save failure rejects the
Start), CT-PS-09 (the Stop reason is reachable only by a target-only yield) and CT-MAIN-03
(no token bytes; the path string is configuration).

## 6. Slices, order and gates

Each slice is a vertical cut in the order of 3.9 with Opus as the single owner (6.1
describes the parallel workers). A slice that changes a service's interface moves its
ported callers in the same commit series; unported callers use only the ledgered
boundaries B-01..B-03 (3.9), so no compatibility layer, dual path or duplicate store exists
at any freeze. Every `s1-baseline` characterization is written and passes in S1, on the
unchanged source and the baseline dependencies, before any port. A porting slice then has
three frozen commits: (a) conversion of the touched suites to `@effect/vitest` with
identical assertions, (b) the port with its target-regression tests, (c) removal of
superseded code and boundaries plus new lint guards. Per development cycle:
`npm run autofix`, `npm run lint`, `npm run typecheck` and the touched suites. At each
freeze: the full suite through the watchdog runner, `npm run test:harness`,
`npm run build`, and a Docker build when dependencies change (S0, S1c, S3, S6d, S7) and at
S8. The same two reviewers review every freeze with the exact revision, delta, evidence
and open objections.

| Slice | Content | Exit gate |
| --- | --- | --- |
| S0 | Vitest 5.0.5 only (effect stays 4.0.1); `vitest.config.ts` (timeouts 0), leak gate with the measured baseline allowlist, `scripts/run-tests.ts` watchdog, harness self-tests, mechanical conversion of 47 suites + fixture; lint and typecheck cover `scripts/**`, Vitest configs, reporters, harness and support files; eslint bans `node:test`; CI `timeout-minutes` and `test:harness` | 863/863 leaves and 6/6 groups identical and passing; timing and leak reports recorded; harness self-tests; lint, typecheck, build, Docker build; CI green on the branch |
| S1 | `s1-baseline` wave (5.4) on the unchanged source and baseline dependencies (effect 4.0.1), including the recorded `s1c-transition-golden` outputs | all S1 tests green; the coordinator's baseline live record (section 7, completed) is the entry evidence of the implementation campaign |
| S1b | D-21: red run of CT-TCTRL-03 recorded as evidence, then the separately reviewed minimal fix with the test | red-then-green evidence; full suite green |
| S1c | Exact 4.0.5 pins for `effect` and companions, `@effect/vitest` 4.0.5; finite runner bounds (5.3 rule 2); Effect timeout self-test; compile-only API probe; concise AGENTS.md rule (section 10) | parity 863/863 and every S1 test unchanged and green on 4.0.5 (transition proof); goldens identical; harness; registry recheck; Docker build |
| S2 | `SupervisorConfig`, `Redacted` token files, JSON `Logger`, typed errors, `SupervisorIds`, elapsed-clock helper, server program in `main.ts` (still started by today's top-level `runMain` until S3), health/status in `supervisor.ts`, root `ThreadPolicy`/`SupervisorOwnership` services, boundary B-01 | CT-CLI-BIN-02 (start signals), CT-MAIN, CT-HEALTH, CT-CONFIG, CT-REDACT-01; no `process.exitCode`, `process.env` or `process.on` outside the config and entry modules |
| S3 | `src/db.ts`; `catalog.sqlite3` (`store.ts`) on `CatalogDb` | per-DB pragma/schema/mode tests; CT-SQL-01..04 for the catalog; Docker build |
| S4 | Native envelope (D-08 spike), `t3.ts`, projection stream, `supervisor-native.ts`, `project-files.ts`, `git-probe.ts` (guidance writes in `Effect.sync` sections), `scripts/probe-t3.ts` | real-ws frame/limit/close/interrupt tests; unknown outcomes; CT-CLOCK-01; CT-PROBE-T3; VM native read probe |
| S5 | `definition-references.ts` (pure), `project-definitions.ts`, `project-config-editor.ts` | YAML Schema diagnostics goldens; editor uncertain/never-retried mapping |
| S6a | Extraction of `SupervisionGate` and `SupervisionControl` on Promise code (3.9); pure modules (IDs injected into `supervisor-workflow.ts` builders); `ScopeLocks`; `SupervisionGate` with the admission section (3.11); helper transport; team runtime | extraction commits pass the full S1 suite unchanged; CT-LIN for helper paths; no `runPromise`, timers or promise chains left in these modules |
| S6b | Conversation, lifecycle, `SupervisionControl`, write controller, team controller, project supervisor, workflow progress, team view, dashboard overview server part | receipts, CAS, unknown-effect, Stop and CT-LIN tests; No Project default; golden identity tests; coordinator reruns the S1 pilot journeys |
| S6c | `service-auth.ts` on `AccessDb` (server-lifetime client + per-forge client) with its HTTP checks and `/auth/*` routes (3.9 T-01); CLI on `effect/cli` with `main.ts` switching to the `import.meta.main` entry guard; `guidance.ts`, `guidance-contract.ts`, MCP route with the SDK adapter, HTTP handlers/router/static, `SupervisionLive` replacing `runGuidanceApplication`; B-01 and all B-03 deleted | DELETE journal and identity tests; CT-AUTH-05; CT-SQL-01..04 for the access file; CT-CLI-BIN-01/03 with BC-CLI expectations; status/body matrix, CSRF/Host/Origin/session, MCP auth/protocol/abort/close; no `Effect.run*` outside the allowlist; VM MCPX direct and `auth forge` |
| S6d | `GuidanceDb` for `guidance.sqlite3`, `PolicyDb` for `thread-settings.sqlite3`; all stores become Effects; critical sections become `withTransaction`; CC-GDB-IMPLICIT wrapped; ownership preload from the guidance layer; B-02 deleted | S1 atomicity tests green on the new engine; CT-SQL-01..04 for these files; no `node:sqlite` import outside the SQL layer and PrivateFiles adapter; Docker build; VM cut-over |
| S6e | Typed interpretation submission (3.12): attempt `attemptId`/`sourcePin` in the envelope; `supervision_interpretation_submit` on `/mcp/workflows`; evidence kind bound to the exact request run and text hash; CAS intake receipt; prompt return and wake; `reconcile` finalizes from the submission; discriminated candidate provenance; final-text parsers and prompts deleted; one-off cut-over; coupled fixtures produce tool items | CT-ISUB-01..19; CT-INT-01 through the tool; no final-chat interpretation text is parsed; coordinator runs the cut-over, the pilot journeys and the model comparison |
| S7 | UI on Atom/AtomHttpApi following 3.8 (Modern Web Guidance → Impeccable → WCAG) | atom tests; replay of UI-STORY-01..08 by the coordinator; Docker build |
| S8 | Remove superseded machinery; final lint bans (`Effect.run*` outside the allowlist, `setTimeout`/`setInterval` in `src`, `ws`/`node:sqlite`/`loadExtension` outside approved adapters); empty leak allowlist; README update | full suite, harness, build, Docker build; handoff to the coordinator for both-host deployment |

Order inside each slice follows the manifest (`order`). File counts per slice are in the
manifest `summary.slice`.

v1 → v2 mapping: v1 S0 → S0 (Vitest only) + S1c (4.0.5 transition, after S1); v1 S1 → S1 +
S1b; v1 S2 → S2 (the CLI moves to S6c); v1 S3 → S3 for the catalog, with the login store
moving to S6c (T-01); v1 S5 (HTTP, MCP, composition) → S6c;
`project-definitions.ts` and `project-config-editor.ts` (v1 S6b) → S5; the v1 S6a/S6b
controllers are regrouped by 3.9; v1 S6c (engine switch) → S6d; S6e is new (Andrea's typed
submission).

### 6.1 Execution with implementation subagents (ANDREA-EXEC-01)

Andrea asked for subagents in the implementation phase to accelerate it. They start only
after both reviewers approve this frozen plan and the coordinator confirms the gate; no
worker runs before that, and none creates an ordinary remote conversation. Opus remains the
sole implementation owner.

1. **Packages.** Each slice is split into work packages (manifest `workPackages`; each row
   names its `workPackage`). Every file, existing or new, belongs to exactly one package
   per slice, so no two workers ever edit the same file. A worker edits only its listed
   files and its listed test files; it asks the owner for any change outside them.
2. **Central ownership.** Opus owns and implements, never delegates: the shared
   contracts and their files (`src/db.ts` and every transaction boundary, the D-01 interim
   critical sections and the S6d caller switch, `src/supervision-gate.ts` with the
   admission section and every send/Stop path's use of it, the composition root and
   boundaries B-01..B-03, the native envelope and sent boundary, the UI registry and
   mutation/draft families), the toolchain and runner (`package.json`, lockfile,
   Vitest configs, watchdog, leak gate, eslint, tsconfig, CI), shared `test/support`
   fixtures, the D-21 fix, the CT-LIN suite, integration and validation.
3. **Contract first.** In each slice Opus first commits the frozen shared interfaces
   (`Context.Service` shapes, Layers, test support) on the integration branch. Workers
   are launched with the T3 `delegate_task` tool, using the provider, model and options
   discovered from `orchestrator_capabilities` (the inherited effort and service options
   travel in `target.options`, never only in the prompt; a native subagent that would drop
   them is not used), with `isolation: "worktree"` for code packages. Each worker starts
   from that commit (uncommitted edits are never relied on), implements against the frozen
   interfaces with test layers, and commits on its own branch. Every returned `taskId` is
   retained and tracked with `task_status`; only terminal results are integrated.
4. **Brief.** Each worker receives: its package ID and file list, the plan sections and
   manifest rows for those files, the frozen interfaces, the target and characterization
   tests it must make pass, the commands to run (`npm run autofix`, `lint`, `typecheck`,
   touched suites, `test:harness` when tooling is touched), the forbidden actions (no edits
   outside its files, no dependency changes, no push, deploy, credential or settings
   change, no `.skip`/`.only`/weakened assertion), and the report format (commit SHA,
   command output summary, deviations, open questions).
5. **Integration.** Opus reviews every worker diff against the contracts (synchronous
   sections, admission sections, receipt-before-send, Schema boundaries, finalizers),
   integrates the commits in dependency order on the bound worktree branch, and runs the
   full slice gate. A conflict is an ownership defect: the commit goes back to its worker,
   never resolved by guesswork. Rejected or abandoned work is discarded explicitly.
6. **Termination.** Every worker is tracked to a terminal result. No frozen review candidate
   is cut while any worker of that slice is still running. Reviewers receive the integrated
   frozen revision with the slice evidence, not worker branches.
7. **Limits.** At most five concurrent workers. Dependent packages wait for the frozen
   interface or the integrated commit they need (`dependsOn`).

| Slice | Opus (central) | Parallel worker packages |
| --- | --- | --- |
| S0 | runner, configs, leak gate, watchdog, harness, package/lock, eslint, tsconfig, CI; parity report | 4 packages of disjoint test suites (mechanical conversion) |
| S1 | `test/support` fixtures (production wiring, fake T3 peer, bin harness); CT-LIN suite; S1b D-21 fix | CT-INT suites; CLI-BIN + PROBE-T3 + CLI cases; per-suite characterization additions in 3 disjoint suite groups; UI baseline fixture (WP-S1-UI, below) |
| S1c | dependency transition, finite bounds, AGENTS.md | none |
| S2 | `main.ts`, `supervisor.ts`, root services, B-01 | foundation services (`config.ts`, `types.ts`, redaction, IDs, logger, errors) |
| S3 | `src/db.ts` (four interfaces) | catalog store |
| S4 | native envelope + D-08 spike | `t3.ts` + projection stream; `supervisor-native.ts`; `project-files.ts` + `git-probe.ts`; probe script |
| S5 | interface review | definitions loader + config editor |
| S6a | extraction commits, `SupervisionGate`/admission, `ScopeLocks` | pure modules; helper transport → team runtime |
| S6b | frozen service interfaces; every admission/critical-section call site review | conversation + lifecycle; write controller + team controller; control + project supervisor + progress + team view + overview |
| S6c | composition (`SupervisionLive`), boundary deletion, `main.ts` entry guard | `ServiceAuth` + CLI + HTTP auth checks; `GuidanceRuntime`; MCP route; HTTP handlers/router |
| S6d | `GuidanceDb`/`PolicyDb` layers and every caller's `withTransaction` | store files in disjoint groups with their store suites |
| S6e | submission authority, intake commit, finalization, candidate provenance, cut-over step, prompts (`src/interpretation-submission.ts`, `reconcile`, conversation evidence) | MCP tool wiring + golden schema; fixture conversion of the coupled suites in disjoint groups |
| S7 | AtomHttpApi service, registry, mutation/draft families, `access.ts`, `api.ts` | project supervisor panels; definitions/editor panels; shell, navigation, No Project, overview |
| S8 | cleanup, bans, README | none |

## 7. Live proof (local coordinator only)

The remote owner cannot claim Mac or VM results. The coordinator runs these on the Lima VM
with existing fixtures, explicit IDs and budget; only owned idle fixtures are cleaned up.
No seeded agreements, no protocol coaching, no first-tool barrier claims, no replay of
historical closed requests, and the no-contact Stop behaviour stays unchanged.

- **Baseline live evidence before any production port (SOL-PLAN-07, A-P01) — completed.**
  The coordinator ran the executable baseline subset on the unchanged VM, uncoached, on
  owned fixtures: a coding request, a greeting, and a genuine agent Start, Stop and
  settlement (L-06, ANDREA-MODEL-01). Every coding interpretation failed closed on
  malformed final JSON, so there was no introduction; the greeting caused no contact; Start
  and Stop passed with exact proof. Rendered prompts, tool arguments, native identities and
  timestamps are retained locally. Afterwards the root model was restored, fixtures
  archived, the owned login revoked, and runtimes, assets, credentials and original
  sessions preserved. This is the S1 entry evidence; it is a current-boundary record, not a
  positive negotiation.
- **What the baseline cannot show live, and where it is proven instead.** A positive
  introduction, helper check-in or negotiation cannot be reached at baseline because
  interpretation fails first, and it must not be forced by coaching, seeding or a repaired
  parser. The unknown-send and Stop races for root check-in, introduction and helper
  webhook are therefore characterized before any port at the Node boundary, with real
  loopback sockets, real HTTP and WS peers, real SQLite files and process kill, and no T3
  change or proxy (CT-INT-03, CT-CONV-01/02 crash variants, CT-TRUN-01, CT-HTX-01,
  CT-LIN-01/03/06, CT-PS-01). Any additional pre-port VM fault check uses only a naturally
  reachable owned state with an explicit ID and budget (an interpretation-dispatch kill
  and restart is the one such case); otherwise it is recorded as deferred with its reason. The
  positive live proofs move to after S6e.
- **UI-STORY-01..08** are not recorded yet. They are recorded before S7 against the
  unchanged `3b8129a` UI and replayed after S7. They are not S1 entry evidence and do not
  delay S0/S1. The coordinator executes them in its own collaborative browser tab with the
  preview tools; WP-S1-UI (below) provides the fixture.
- **UI baseline fixture (WP-S1-UI, after plan alignment, alongside S0/S1).** Owner or a
  worker writes, the coordinator runs:
  - an isolated localhost test fixture under `test/ui-fixture/`: an Effect v4 HTTP server
    (`HttpRouter` on `NodeHttpServer`, bound to `127.0.0.1` on an ephemeral port, started
    and stopped by a scoped runner, never a service) that serves the actual unchanged
    compiled UI assets of `3b8129a` from a directory the parent copies, and answers the
    `/api/guidance/*`, `/api/csrf` and `/auth/*` calls with recorded or synthetic data
    decoded through the existing `SupervisorApi` schemas;
  - no proxy or relay to any Supervisor, no forwarding, no real API writes, no real user
    or project controls, no credentials; every response carries
    `x-supervisor-fixture: <scenario>`, and recordings are labelled `fixture` or `native`;
  - deterministic scenario controls under a fixture-only `/__fixture/` prefix: session
    expiry on the next API call, sign-out from another tab, a mutation POST that is
    received and then never answered or dropped (unknown outcome), 401, 403, 409 and 413
    on save, conflict and uncertain editor saves, slow reads, setup races and reload;
  - a request log (method, path, body hash, scenario, monotonic time) that shows every
    mutation POST received once and never replayed, drafts, auth and operation fences
    retained across reload and re-sign-in, and one poll per interval;
  - plain DOM snippets only at the browser boundary for the coordinator's checks; the
    runner, server and fixture self-tests (`test/ui-fixture/*.test.ts`: binds only
    loopback, never forwards, scenarios deterministic, no write leaves the process) use
    Effect v4 and run under the S0 runner.
  Each story records the actual per-panel behaviour (including navigation blocked by a
  dirty-draft guard or an explicit discard) rather than assuming every draft survives every
  unmount, and that recorded behaviour is what S7 must preserve.
  UI-STORY-01..05 and 07 run on the fixture; UI-STORY-04, 06 and 08 can also run on the
  native deployment (read-only, owned fixtures). StrictMode checks need a development build
  of the same commit and are optional. Design, CSS, PNG marks and copy are untouched; the
  prepared UI skill sources (`/tmp/effv4-ui-skills`) apply to S7 only, and no aesthetic work
  delays S0/S1. No positive baseline negotiation is fabricated.
- **After S2:** `docker stop` gives exit 130 with finalizers run; health ready; JSON log
  lines unchanged in shape.
- **After S3:** the ported build opens the existing state volume: catalog cursor continues,
  `-wal`/`-shm` modes 0600, health ready.
- **After S4:** real T3 watch (snapshot then Ack, heartbeat over 60 s idle, reconnect after
  a T3 restart); a native read RPC and a git probe on a real checkout.
- **After S6a/S6b:** rerun the baseline subset (coding, greeting, Start/Stop) and compare it
  with the baseline record; an uncoached No Project Start then Stop during interpretation
  (exactly one notice). Interpretation still uses final JSON until S6e, so failing closed
  stays the expected outcome; nothing is coached.
- **After S6c:** `login.sqlite3` stays DELETE with a byte-identical schema;
  `t3-supervisor auth forge` inside the deployment gives token-only stdout and the exit
  codes; sign-in works and existing sessions survive a restart. MCPX connecting directly to
  `/mcp/workflows`: initialize, tools/list, a
  bounded `workflow_read`, and a `workflow_write` (first call may be pending; the identical
  retry applies once). No session header, bearer only, Host allowlist, foreign Origin
  rejected.
- **After S6d:** cut-over on the Lab `guidance.sqlite3` under concurrent MCP writes and the
  supervision cycle: no SQLITE_BUSY and no newly introduced self-contention (measured
  event-loop delay against the S1 baseline workload; the synchronous `busy_timeout`
  limitation remains), pragmas unchanged, team/monitor/receipt rows intact, definitions
  revision identical.
- **After S6e:** run the one-off cut-over (3.12 item 11) when no interpretation is in
  flight where possible and confirm retained agreements stay valid. Then the first positive
  live proofs, uncoached, through the typed submission tool:
  - an operative request reaching introduction and, if it happens naturally, exact
    operative acceptance, with first edit, introduction and acceptance recorded separately;
  - the unknown-send and Stop races for a root check-in, an introduction and a helper
    webhook POST (Stop while in flight; connection cut or process kill between the
    `sending` record and the receipt, then restart): no duplicate native message, the
    original identity reconciled, exactly one operative notice;
  - the greeting no-contact case again.
  Repeat the model comparison of 3.12 (Luna MAX versus Sol 6.1 LOW, Luna HIGH labelled
  separately) as the default gate. If a positive journey still does not happen naturally,
  that is recorded as a result, not coached.
- **After S7:** replay UI-STORY-01..08.
- **Batch completion:** both-host deployment, state preservation, native MCP and browser
  acceptance, and Lab records (coordinator only).

Mounted UI stories (SOL-PLAN-06, A-P06), recorded on the baseline build and replayed after
S7:

| ID | Story |
| --- | --- |
| UI-STORY-01 | Configuration editor: dirty `project.yaml`/step/workflow draft survives section, project and chat navigation and session expiry with re-sign-in; Save after 401 reports "not saved" and keeps the draft; conflict or uncertain blocks further saves until refresh |
| UI-STORY-02 | Project panel drafts (model, monitoring, team settings) across section/project/chat navigation and re-sign-in; explicit Save/Retry only |
| UI-STORY-03 | Session expiry during a pending Save or Start: outcome shown as unconfirmed, fence kept, no automatic replay after re-sign-in |
| UI-STORY-04 | Real browser Back/Forward and manual hash edits with a dirty draft |
| UI-STORY-05 | Two tabs: sign-out in one signs out the other (storage event); sign-in in one tab; no draft crosses sessions |
| UI-STORY-06 | Unmount and StrictMode (dev build): one poll per interval after navigation, no leaked listeners, subscriptions or timers |
| UI-STORY-07 | Concurrent setup and reload; Start whose POST is cut keeps its fence across reload; dashboard Stop/Enable |
| UI-STORY-08 | Keyboard and focus: visible focus, 200 %/400 % zoom, 320 px reflow on the main surfaces |

## 8. Scanner reference (read-only)

Reference revision: Scanner `main` = `origin/main` =
`c17ab1a52ad9ac75beb46e1d2980c4cfc9c53f26` (2026-10-22, "fix(empasa): release the last
manufacturing batch after cancel (#2512)"). It uses `effect` 4.0.1 and companions 4.0.1
(`api/package.json`, `frontend/package.json`, `pnpm-workspace.yaml` catalog) with
`effect-app` 4.0.0 and Vitest `^4.1.7`. A read-only `git archive` snapshot for all peers is
at `/tmp/scanner-c17ab1a` (`.snapshot-commit`, `.snapshot-info`); the Scanner working tree,
branch and settings were not touched. Patterns are adapted to core `effect` 4.0.5; effect-app
is not added as a dependency.

| Scanner pattern (c17ab1a) | Adopted as | Deviation for Supervisor |
| --- | --- | --- |
| `Context.Service<Self>()("id", { make })` services, e.g. `api/src/Amazon/OnePick/services/PrinterEngagements.ts`, `api/src/Amazon/MultiPick/core/priorisation.ts` (via `effect-app/Context`) | the same form from core `effect` (4.0.5 `Context.ts:327-392` supports `make`) with `Layer.effect(Self, Self.make)`; explicit shape form where a test double needs a fixed interface | import from `effect`, not `effect-app` |
| ref-counted per-key `Semaphore` with `acquireUseRelease` (`api/src/services/namespacedLock.ts`) | `ScopeLocks` = `RcMap<scopeKey, Semaphore>` for CC-SCOPE-SERIAL | `RcMap` (stable) gives the same release-on-last-user semantics only when `RcMap.get` is leased in each operation's own scope (3.5, O-04) |
| `SqliteClient.layer` + directory creation via `Layer.effectDiscard` (`api/src/lib/sql.ts`) | per-file client layers built once at the root | no `SqliteMigrator` (D-04); files created and chmodded 0600 before open; `FileSystem` instead of `fs.existsSync`; login DB `disableWAL` |
| error model (`wiki/architecture/error-model.md`): `Data.TaggedError` for local diagnostics, schema-backed errors at wire/persisted boundaries, translate at the boundary, inner `reason` unions, never stringify causes | section 3.10 (plus: logs and spans carry sanitized classifications only) | Scanner's `S.TaggedErrorClass` is an effect-app addition; core 4.0.1/4.0.5 only have `Schema.TaggedError` (`Schema.ts:16653`) |
| repository write boundaries (`wiki/architecture/repository-write-boundaries.md`): atomic by default; chunking only when idempotent and restartable | CC-GDB / CC-SYNC-ATOMIC | none |
| layer tests `it.layer(layer)("suite", (it) => it.effect(...))` (`api/test/EasyLife/PackSpotLease/PackSpotLeases.test.ts`); in-memory `SqliteClient` + `TestClock.setTime` (`api/test/lib/WorkflowMonitoring.test.ts`); tests import production symbols (`AGENTS.md`) | test layers and TestClock use | stores whose contract involves WAL, file modes or restart use temp-file SQLite; `:memory:` only for pure query logic |
| `ConfigProvider.fromEnv` + JSON logger + `runMain` (`api/src/lib/basicRuntime.ts`); `Config.redacted` and `HttpRouter.middleware` layers, global vs route (`api/src/router.ts`) | sections 3.1 and 3.7 | env names stay exact (no `constantCase` mapping); never a default secret (Scanner defaults its auth secret); exact Supervisor bodies/status codes |
| `effect/rpc` with `RpcSerialization` (`api/src/router.ts`, `api/src/{EasyLife,Empasa,Mako}/PrintWorkerEntities/*`) | candidate for the native envelope (D-08) | T3 owns the protocol; only a spike against recorded frames can adopt `RpcClient` |
| AGENTS.md "Refactors end in a clean state": full replace, no aliases or shims | same rule for every slice | none |

Not adopted: the effect-app framework (Req/Command/controllers, repositories), cluster,
workflow/DurableDeferred, Vue and `@effect/atom-vue`, and Scanner's Vitest configuration
(it has no leak gate or timeout policy, so it is no reference for D-05). Scanner pairs
`@effect/vitest` 4.0.1 with Vitest `^4.1.7`, although that package declares the peer range
`vitest >=5.0.0 <6.0.0`; Supervisor uses Vitest 5.0.5 as `@effect/vitest` 4.0.5 requires.

## 9. Residual adapters (justified, scoped)

| File | Adapter | Why | Cleanup |
| --- | --- | --- | --- |
| `src/workflow-mcp.ts` | `@modelcontextprotocol/sdk` stateless Streamable HTTP transport inside one Effect route; tool callbacks run Effects with the request fiber's captured context (`Effect.runPromiseWith`), forks in a request-scoped `FiberSet` | Effect `McpServer` is sessionful for all current protocol versions (D-03); the SDK calls Promise callbacks (O-06) | per-request scope; abort on client close; CT-MCP-03/04 |
| `src/service-auth.ts` | private-files adapter over `node:fs/promises` (O_NOFOLLOW/O_DIRECTORY/O_EXCL open, lstat dev/ino, fchmod, fsync, link) | `FileSystem` 4.0.5 has no lstat, those flags or handle chmod (`noFollow` covers only the final component on open) | `acquireRelease` per handle |
| `src/t3.ts`, `src/supervisor-native.ts`, `src/project-files.ts`, `src/git-probe.ts` | one custom `Socket.WebSocketConstructor` over `ws` (or one envelope adapter if D-08 rejects `RpcClient`) | `NodeSocket` passes only headers: no `maxPayload`, and listener removal can leave a connecting socket's `error` unhandled | socket scope terminates on release |
| `src/supervisor-helper-transport.ts` | native T3 scheduled-task webhook POST via `HttpClient` | the only helper delivery channel; the capability URL is POSTed once by Supervisor (no client retry); redirect handling matches baseline `fetch` as pinned by CT-INT-03 H6 (D-16) | request scope |
| `src/project-definitions.ts`, `src/project-config-editor.ts` | `yaml` `parseDocument`/`stringify` before Schema decoding | comment-preserving YAML with duplicate-key detection has no Effect equivalent | pure (no resources) |
| `ui/src/access.ts` | `localStorage` + `storage` events + auth-required event | cross-tab semantics not provided by `KeyValueStore.layerStorage` | listener in the atom/runtime scope |
| `ui/src/navigation.tsx` | History API + hash events + restore timer around the deterministic navigator | no Effect platform service for history | listeners and timer released with the atom/component |
| `ui/src/main.tsx` | `beforeunload` and `document.title` | DOM lifetime side effects | effect cleanup (unchanged) |
| `scripts/run-tests.ts` | process-group watchdog over `vitest run` (`effect/process`) | must stay independent of the tested runtime to kill a blocked worker (O-03) | group TERM, KILL after 10 s, exit 124 |

Temporary, not adapters: the composition-root boundaries B-01/B-03 (removed in S6c) and the
interim synchronous `guidance.sqlite3`/`thread-settings.sqlite3` API B-02 (removed in S6d),
section 3.9.

## 10. AGENTS.md rule (added in S1c)

S1c adds this rule to `AGENTS.md` and nothing else from the plan:

> **Effect v4 throughout.** The application, CLI, tooling and tests use Effect v4 at one
> exactly pinned version for `effect` and every `@effect/*` package. Write services as
> `Context.Service` with Layers, decode untrusted input and stored rows with `Schema`,
> persist through `effect/sql`, keep UI async state in Atom/AtomHttpApi, and test with
> `@effect/vitest` (`TestClock` for timing, `it.live` for real I/O). Do not call
> `Effect.run*` in business code or add Promise polling, ad hoc timers or hand-rolled async
> state machines. Never log raw causes, tokens or native bodies. Third-party, native and
> browser integrations stay small scoped adapters with a recorded reason; pure
> calculations, types and JSX stay plain.

## 11. Non-code audit

Every non-code file has a disposition and rationale in the manifest (`auditRationale`).

- **Update:**
  - `package.json` and `package-lock.json`: S0 adds `vitest` 5.0.5 and the scripts
    (`test` → `node scripts/run-tests.ts`, `test:harness`; `lint`/`autofix` cover `scripts`,
    Vitest configs and test tooling); S1c sets exact 4.0.5 pins and adds `@effect/vitest`;
    S3 adds `@effect/sql-sqlite-node` 4.0.5; S7 adds `@effect/platform-browser` 4.0.5 only
    if `BrowserKeyValueStore` is adopted.
  - `tsconfig.json`: typecheck includes `scripts/**/*.ts`, Vitest configs, `test/support/**`
    and `test/harness/**` (today `scripts/probe-t3.ts` is neither linted nor typechecked).
  - `eslint.config.js`: same coverage; slice-by-slice bans with core rules only, each
    allowance naming its file (`node:test` S0; `Effect.run*` outside the allowlist from
    S2; `ws` outside the envelope adapter S4; `node:sqlite` outside the SQL layer and
    PrivateFiles adapter S3/S6d; `loadExtension` S3; `setTimeout`/`setInterval` in `src`
    S8).
  - `.github/workflows/check.yml`: `timeout-minutes: 30` and `npm run test:harness`.
  - `AGENTS.md`: section 10.
  - `README.md`: S8. The development section names Vitest. The "same dependency lock"
    sentence in "Node security runtime" must distinguish the October Node rebuild from this
    dependency change.
- **Preserve:**
  - `PRODUCT.md`, `DESIGN.md`, `.impeccable/*`, `ui/index.html`, `ui/src/style.css` and
    the three PNG marks: byte-identical; no visual change and no mechanical asset edits.
  - Skills: portable product usage, nothing user-visible changes, so no Skillshare
    propagation.
  - Historical docs and proposals (`docs/guidance.md`, `docs/intent-guidance-review.md`,
    `docs/proposals/*`).
  - Behaviour docs (`docs/project-definitions.md`, `project-supervision.md`,
    `steps-and-workflows.md`, `supervisor-team.md`, `workflow-mcp.md`): re-checked in S8
    only for mechanism wording; they are the behavioural spec for characterizations.
  - `Dockerfile` (`CMD ["node", "dist/main.js"]` keeps working through the
    `import.meta.main` entry; Node 24.22.1 digest pins unchanged), `compose.yaml`,
    `.env.example`, `.dockerignore` (test/ and tooling stay outside the image),
    `.gitignore`, `tsconfig.build.json`, `ui/tsconfig.json`, `ui/src/vite-env.d.ts`,
    `vite.config.ts`.
- **New files** (manifest `plannedNewFiles`): `vitest.config.ts`,
  `vitest.harness.config.ts`, `scripts/run-tests.ts`, `test/support/leak-gate.ts`,
  `test/harness/*`, `test/support/*` (shared Effect test layers and the CT-INT production
  wiring fixtures), `test/ui-fixture/*` (UI baseline fixture and its self-tests, section 7), `test/support/cli-bin.ts` (built/installed bin harness),
  `src/db.ts` (the four named database interfaces and their layers),
  `src/supervision-gate.ts`, `src/supervision-control.ts`, and a compile-only API probe
  under `test/harness/`.

## 12. Decisions

Resolved with the reviewers' terminal findings and Andrea's directions (reviewers confirm on
the frozen v2):

| ID | Decision | v2 state |
| --- | --- | --- |
| D-01 | Order for `guidance.sqlite3`/`thread-settings.sqlite3` | accepted in principle by both reviewers; interim whole-block `Effect.sync` sections over the existing objects in S4–S6c, one coordinated engine and caller switch in S6d (3.4); per-row `phases` |
| D-02 | CLI | Andrea: Effect end to end, `effect/cli` extension points first; BC-CLI-01..04 flagged for both reviewers (3.1). Astra's alternative (pure argv + Schema) is not needed |
| D-03 | MCP transport | accepted by both: SDK stateless transport as a scoped adapter; Effect owns route, auth, body bound, timeout, abort, close; captured-context callback bridge named (3.7, O-06) |
| D-07 | Stop window | replaced by CC-STOP-LIN (3.11): no snapshot (baseline has none), one admission section, admission is the send linearization point |
| D-08 | Native envelope | conditional S4 spike accepted; adds the no-extra-`Interrupt`/no-early-Ack criterion (3.6) |
| D-23 | Transition order | dependency extraction of `SupervisionGate`/`SupervisionControl` and the slice order of 3.9; boundaries only in the composition root (B-01..B-03) |
| D-24 | `login.sqlite3` lifetimes | one server-lifetime client, one per-forge client in the CLI process, never two in one process (3.2) |
| D-25 | Admission granularity | one process-wide admission `Semaphore(1)` (3.11) rather than per-scope keys |
| D-27 | Typed interpretation submission (Andrea) | architecture accepted by both reviewers (run 3); 3.12 as reconciled: CAS intake bound to the exact request run, prompt return plus wake, existing completed-run finalization and introduction path, discriminated candidate provenance, one-off evidence-preserving cut-over, no model-chosen target, no fallback; slice S6e after S6d so it is built once on the final engine |
| D-29 | Synchronous cross-slice calls | explicit transitions T-01..T-07 (3.9): `ServiceAuth` and the CLI port in S6c with their synchronous HTTP callers; kept synchronous methods are B-02 reads or pure computations only |
| D-30 | UI baseline proof | an isolated loopback Effect v4 fixture serving the unchanged compiled UI with recorded or synthetic data and deterministic scenarios (section 7, WP-S1-UI); the coordinator records UI-STORY-01..08 with the preview tools before S7 |
| D-28 | Interpretation model default (Andrea) | evidence-based only (3.12): GPT-6.1 Sol LOW becomes the default only with equal or better correctness on every fixture case and lower interpretation/negotiation latency than GPT-6 Luna MAX; defaults and settings unchanged until then |

Owner defaults (reviewers may object):

- **D-04:** no `SqliteMigrator`; keep the idempotent DDL, including the prototype `ALTER`
  guards; removing them is a separate data-safety ledger item.
- **D-05:** runner policy in 5.3 (timeouts 0 only in S0; finite bounds from S1c).
- **D-06:** config parsing keeps baseline semantics (`preserveEmptyStrings`, `Number()`).
- **D-09:** custom `WebSocketConstructor`.
- **D-10:** shutdown with dependents first (accepted as intended resource-lifetime
  correction; CT-MAIN-02 is a target-regression test).
- **D-11:** remove the legacy `ui-login-code` deletion in S8 once the coordinator confirms
  the file is absent on both hosts.
- **D-12:** router-level auth middleware.
- **D-13:** MCP tool inputs decoded with `Schema` around the existing parsers and reason
  codes; raw arguments retained for proof; forbidden excess fields rejected; advertised
  JSON Schemas byte-identical (3.10).
- **D-14:** stored JSON decoded with `Schema` that accepts every historically valid row and
  keeps the `incompatible` classification; no fallback path (3.10).
- **D-15:** IDs through `Crypto.randomUUIDv4`; pure builders receive IDs (3.5).
- **D-16:** webhook POST via `HttpClient` over `fetch`, with redirect behaviour as pinned by
  CT-INT-03 H6 and no client retry; changing redirect handling is a separate decision.
- **D-17:** ownership preload from the guidance layer order.
- **D-18:** single-flight presence/activation semantics chosen after CT-PS-05.
- **D-19:** no DOM test dependency; mounted baseline stories UI-STORY-01..08 recorded by
  the coordinator before S7 and replayed after; atom tests complement them (3.8).
- **D-20:** 4.0.6 or later only as its own ledger item once every companion is `latest`.
- **D-21:** delete the write-only `pendingCandidates`; fix the phantom owned-ID rollback in
  S1b as a narrow, separately reviewed fix with red-then-green evidence (accepted by Astra).
- **D-22:** the team-controller tests stay in `workflow-write-controller.test.ts` (name and
  file parity).
- **D-26 (accepted by both reviewers):** the GuidanceStore notice-pipeline methods
  `commit`, `start`, `finish`, `reset`, `reserveTokens`, `notices`, `resolveEpisode`,
  `saveRule` and `mute` have no `src` caller (`classify` is a test fixture and stays). S6d
  deletes them in a separately reviewed commit carrying the call-graph proof instead of
  porting them; constructor recovery (CC-RECOVERY), stored rows and their readers stay. The
  proposed CT-GDB-03..05 are retired rather than written for code about to be removed; no
  existing assertion disappears.

## 13. Findings and acceptance ledger (v2)

One ledger for both reviewers, Andrea's directions and the owner's findings. "Resolved in
v2" means the plan and manifest now meet the stated requirement; each reviewer confirms or
reopens it on the frozen revision. Manifest rows carry the IDs that affect them in
`reviewFindings`; `reviewLedger` in the manifest repeats this table with evidence anchors.

| ID | Source | Requirement (short) | Response and evidence | Status |
| --- | --- | --- | --- | --- |
| SOL-PLAN-01 | Sol P0 | complete native-authorized mutation and real helper HTTP characterizations | CT-INT-01 (authenticated MCP `workflow_write` → production-wired write controller → production native adapter → loopback T3 HTTP/WS peer → real `guidance.sqlite3`: valid proof, weak/foreign/truncated/missing/lagged proof with zero rows, replay/conflict, Stop/generation/source change), CT-INT-02 (`supervision_team` through `authorizeNative`), CT-INT-03 (production team runtime + transport + global `fetch` over a real loopback socket: lost reply + restart, stalled/truncated 2xx, Stop/quarantine before and after the POST, redirect), all `s1-baseline` (5.4; registry) | resolved in v2 |
| SOL-PLAN-02 | Sol P0 (run 4: open, narrowed to in-flight ownership) | Stop ordering must cover policy-dependent SQL mutations, not only sends; reconcile admission with actual adapter initiation | 3.11 items 1, 2, 4 (one process-wide `admit` for Stop/Enable, sends and the 50 policy-dependent writes; synchronous `initiate`); v2.2: in-section `FiberMap.get` and durable-receipt lookup before any initiation, registration in the same masked body without `onlyIfMissing`, total mapped operation with `ensuring(release)`, the initiating caller as sole cancellation owner (owner cell + `onInterrupt`), duplicates join only; CT-LIN-05 steps 1-7; exact 4.0.5 probe `docs/effect-v4-admission-probe.mjs` (8/8 cases); `sol-v21-frozen-plan-review.md` | resolved in v2.2 |
| SOL-PLAN-03 | Sol P1 (run 3: partial) | real call shapes and acquisition/injection points for synchronous consumers; CLI/config without a fake supervision runtime | 3.9 B-03 call-shape rule (`temporaryBoundaries.callShapes`), I-01/I-02 injections, B-04 T-01..T-07 (ServiceAuth + CLI in S6c, retained pure `loadDataDirectory`, saveThreadPolicy handler in S6a) | resolved in v2.1 |
| SOL-PLAN-04 | Sol P1 | phase/seam/expected/target per case; known failures as red evidence; consolidation | 5.1 phases; registry fields for every case; CT-TCTRL-03 `known-failure` in S1b with D-21; consolidations in 5.4 | resolved in v2 |
| SOL-PLAN-05 | Sol P1 | compiled/installed bin harness, signals, probe cases, tooling in lint/typecheck | 3.1 (CT-CLI-BIN-01..03, CT-PROBE-T3-01..05, entries), 5.3 rule 4, section 9 watchdog row, section 11 lint/typecheck coverage | resolved in v2 |
| SOL-PLAN-06 | Sol P1 | mounted baseline stories, lifetimes, scope/session keys, mutation non-replay, guidance order | 3.8; section 7 UI-STORY-01..08; CT-UI-EDITOR-01, CT-UI-SETUP-01 | resolved in v2 |
| SOL-PLAN-07 | Sol P0 (run 3: execution gate) | honest baseline VM subset; executable S1 fault tests; positive fault proof after S6e; UI stories before S7 | section 7: the executable baseline subset is completed and recorded; positive introduction/helper races are characterized at the Node boundary before any port and proven live after S6e; extra pre-port VM checks only on a naturally reachable owned state, else deferred with reason; UI-STORY-01..08 before S7 with actual per-panel behaviour | resolved in v2.1 |
| SOL-PLAN-08 | Sol P1 | monotonic elapsed time, wall time for stored timestamps, clock-jump test | 3.5 CC-CLOCK-ELAPSED/CC-CLOCK-WALL; CT-CLOCK-01; rows `t3.ts`, `t3-projection-stream.ts`, `workflow-write-controller.ts` | resolved in v2 |
| SOL-PLAN-09 | Sol P1 | mandatory Schema boundaries; exact API spellings; stale labels | 3.10; rows name decode boundaries; `Layer.scoped`/`Schema.parseJson` removed; stale D1–D11/S3d labels mapped; API check script 0 problems | resolved in v2 |
| A-P01 | Astra (run 3: open) | adapt synchronous consumers at each service transition (auth, CLI/config, `noProjectControl`/`startStatus`/`saveThreadPolicy` handlers) | 3.9 B-04 T-01..T-07 and call shapes; ServiceAuth, CLI and the `main.ts` entry guard in S6c with their callers; retained pure `loadDataDirectory`; work packages WP-S6c-AUTH/WP-S6c-COMP | resolved in v2.1 (Astra `plan-v2-review.md`) |
| A-P02 | Astra | one server-lifetime auth client; forge separate; concurrent HTTP-login test | 3.2 table and D-24; CT-AUTH-05 | resolved in v2 |
| A-P03 | Astra (run 4: open, narrowed) | one process-wide contract in plan and manifest; actual adapter initiation, not a fork (Astra's 4.0.5 probe `harness-probe/admission-fork-v2.json`); coordinate legacy Stop callers from S6a | 3.11 "In-flight lookup and resource ownership" and "Cancellation owner"; CT-LIN-05 steps 4-7 (duplicate, owner interruption at handoff and during the reply, Stop while pending, scope close); `FiberMap.get` lookup, no `onlyIfMissing` (`FiberMap.ts:1427-1428`); probe results under CT-LIN-05; `plan-v2.1-review.md` | resolved in v2.2 |
| A-P04 | Astra | separate baseline characterization, Vitest-only parity, 4.0.5 transition goldens and new regressions | 5.1 phases; S0/S1c split; CT-MAIN-02 and CT-PS-01 split; registry `reuses`/`newObservation` | resolved in v2 |
| A-P05 | Astra | finite runner and finalizer bounds after S0; self-tests; watchdog escalation; specific leak allowlist | 5.3 rules 2–5 | resolved in v2 |
| A-P06 | Astra | mounted baseline matrix; query vs mutation lifetimes; scope keys; editor and setup drafts | 3.8; UI-STORY-01..08; CT-UI-EDITOR-01, CT-UI-SETUP-01 | resolved in v2 |
| A-P07 | Astra | Schema at every boundary; raw proof retention; excess fields rejected; sanitized logs including nested causes and capability URLs | 3.10; CT-REDACT-01; rows | resolved in v2 |
| A-P08 | Astra | clock domains; exact 4.0.5 APIs; `effect/rpc` pin; IDs in pure builders; RPC spike without extra `Interrupt` | 3.5, 3.6, 3.10, section 2 pin policy | resolved in v2 |
| O-01 | Astra | consolidate overlapping proposals | 5.4 consolidation list; registry `consolidateInto` | resolved in v2 |
| O-02 | Astra | no new isolated suites for unchanged pure helpers already proven | registry `disposition: drop-reuse` with the covering test | resolved in v2 |
| O-03 | Astra | probe coverage; watchdog/harness tooling rationale | CT-PROBE-T3-01..05; section 9 watchdog row; 5.3 rule 4 | resolved in v2 |
| O-04 | Astra | `RcMap.get` leased per operation | 3.5; CT-PS-11 queued cancellation | resolved in v2 |
| O-05 | Astra | no absolute "no event-loop stall" claim | 3.2 rule 5; section 7 S6d bullet | resolved in v2 |
| O-06 | Astra | name the SDK callback bridge and its request scope | 3.7; section 9 | resolved in v2 |
| ASTRA-EARLY-01 | Astra (early) | login DB is one service-lifetime connection, forge separate | 3.2; D-24 | resolved in v2 |
| ANDREA-CLI-01 | Andrea | CLI on Effect end to end via `effect/cli`; preserve token stdout, commands, path security, exit meaning; flag behaviour changes | 3.1; BC-CLI-01..04 accepted by both reviewers (run 3) | resolved |
| ANDREA-EXEC-01 | Andrea | use subagents in the implementation phase after the plan gate; disjoint ownership, shared contracts central, isolated worktrees, owner integration, every worker terminal before each frozen candidate | section 6.1; manifest `workPackages` and per-row `workPackage` (no file in two packages of one slice, checked by the generator) | resolved in v2 |
| ANDREA-ITOOL-01 | Andrea | typed Supervisor MCP interpretation submission validated with `Schema`, exact native identity/source/run/binding authority, no T3 change, superseded parsing removed, no fallback or duplicate store | 3.12 items 1–8, 11, 12; CC-INTERP-SUBMIT; CT-ISUB-01..19; slice S6e; D-27 | reconciled with both design reports (v2.1); pending reviewer confirmation |
| ANDREA-ROUTE-01 | Andrea | could the tool also dispatch to the right thread? | 3.12 answer and item 9: yes, a successful submission starts the existing service-owned delivery to the bound operative; no model-chosen destination and no send inside the tool | reconciled (both reviewers agree) |
| SOL-ISUB-01 | Sol P0 (run 3) | write-once per interpretation attempt, not per reused task ID; source-edit and definition-renewal scenarios | 3.12 items 1 and 5 (attempt key, `attemptId`, receipts in the existing receipt table, task pointer, superseded attempts `stale`); CT-ISUB-19 | resolved in v2.1 |
| SOL-ISUB-02 | Sol P1 (run 4: partial) | candidate store and `proposalEvidenceCurrent`, proof re-verification before apply and Start, retained request/agreement cut-over without a permanent parser | 3.12 items 7, 8, 11 and CT-ISUB-07/10/16/17; v2.2: candidate-free inferred/provisional tasks and their introductions get `TaskRecord.interpretationEvidence` (same discriminated union); the cut-over validates their legacy message once and records `supervisor_message` with plan digest and source pin, or stale with the baseline result; CT-ISUB-17 parameterized with `supervisor-conversation.test.ts:2482` | resolved in v2.2 |
| I-03 | Astra (run 3) | persisted candidate/agreement provenance, bounded cut-over (agreements, unsent introductions, pending Start, in-flight requests), re-verification before all application including bare Start, receipt lookup before the state gate, final-chat interpretation wording | 3.12 items 5, 7, 8, 11, 12; CT-ISUB-04/07/10/16/17; CC-INTERP-SUBMIT participants include `supervisor-conversation-store.ts` | resolved in v2.1 |
| SOL-ITOOL-1 | Sol design | actual authenticated MCP → controller → real native proof → real SQL receipt; wrong root/helper/run/provider/source/generation, weak/forged/rolled-back, excess keys and lag rejected; raw input not stripped | 3.12 items 2–4; CT-ISUB-02, -03 | resolved in v2.1 |
| SOL-ITOOL-2 | Sol design | prompt return with a staged receipt; finalize once on successful completion; ignore final prose and JSON | 3.12 items 6–7; CT-ISUB-01, -09, -10, -15 | resolved in v2.1 |
| SOL-ITOOL-3 | Sol design | concurrent and replayed calls give one result and one introduction; conflicts cannot replace; SQL failure rolls back result, proof and receipt | 3.12 item 5; CT-ISUB-04, -11 | resolved in v2.1 |
| SOL-ITOOL-4 | Sol design | source, definitions, binding, control and Stop/Enable fences at every proof/apply/send boundary; unknown delivery keeps route, body and IDs | 3.12 items 5, 7, 9; CT-ISUB-06, -08 | resolved in v2.1 |
| SOL-ITOOL-5 | Sol design | pending Start accepts only its exact pinned interpretation; negative Start and greeting cause no contact; bare Start may activate without a workflow; no No Project shortcut | 3.12 items 5, 7; CT-ISUB-07, -12 | resolved in v2.1 |
| SOL-ITOOL-6 | Sol design | initial candidate evidence uses the submission end to end; operative acceptance still required | 3.12 items 8, 10; CT-ISUB-13, -16 | resolved in v2.1 |
| SOL-ITOOL-7 | Sol design | a structurally valid stale-CSV interpretation is semantically wrong; uncoached correctness trials | 3.12 model comparison (semantic correctness judged separately) | resolved in v2.1 |
| SOL-ITOOL-8 | Sol design | bounded cut-over for in-flight JSON-only requests and retained candidates; never rewrite or re-send under old IDs; no invented submission; no permanent old-parser branch | 3.12 item 11; CT-ISUB-17 | resolved in v2.1 |
| A-I01 | Astra design | exact request/run/source authority and pending-Start-only permission | 3.12 items 1, 4, 5; CT-ISUB-02, -07 | resolved in v2.1 |
| A-I02 | Astra design | non-blocking durable receipt, native-completion and replay recovery, Stop/send admission, unknown IDs | 3.12 items 5–7, 9; CT-ISUB-04, -08, -11, -15 | resolved in v2.1 |
| A-I03 | Astra design | all shared candidate and agreement evidence consumers, bounded preservation cut-over, removal of final-chat fallback | 3.12 items 7, 8, 11; CT-ISUB-09, -16, -17 | resolved in v2.1 |
| A-I04 | Astra design | strict typed limits, provisional semantics, updated prompts, real-boundary tests, redacted typed errors | 3.12 items 3, 6, 12; CT-ISUB-03, -05, -18 | resolved in v2.1 |
| ANDREA-ITOOL-EVAL-01 | Andrea | evaluate (only) whether other model-to-service structured results need typed MCP tools; add none for uniformity | 3.12 gap table, matching both reviewers' evaluations: interpretation needed and approved; later proposal/acceptance records a possible future gap only; definition decisions, contribution reports, workflow, team, guide, check-in markers, Start/Stop kept; monitoring unnecessary | evaluated; no other tool |
| ANDREA-MODEL-01 | Andrea | compare correctness and speed of GPT-6 Luna MAX and GPT-6.1 Sol LOW (Luna HIGH labelled separately); interpretation/validation and negotiation latency only | 3.12 model comparison table and protocol; section 7 S6e bullet; D-28. Baseline (same retained root, sequential): bare Start Luna HIGH 9.114 s, Luna MAX 5.713 s, Sol LOW 7.777 s; greeting 16.509 s (stale CSV, malformed), 19.554 s (stale CSV, malformed), 3.019 s (correct `not_needed`); coding plan malformed / 13.659 s (stale CSV, malformed) / 17.576 s (malformed, no stale CSV); Stop and settlement passed for each; no negotiation reached | open: post-S6e quality and latency comparison is the default gate; defaults unchanged |
| COORD-UI-01 | Coordinator | bounded UI baseline proof package: isolated loopback fixture serving the unchanged compiled UI, deterministic scenarios, fixture/native labels, no proxy and no real writes; coordinator records UI-STORY-01..08 before S7 | section 7 (UI baseline fixture), section 6.1 S1 row, D-30, WP-S1-UI, CT-UI-FIXTURE-01 | prepared in v2.1 |
| D-26-ACCEPT | Sol and Astra (run 3) | D-26 accepted: delete the unused GuidanceStore notice-pipeline methods with call-graph proof; keep constructor recovery, stored rows and fixture `classify`; retire CT-GDB-03..05 | section 12 D-26; registry CT-GDB-03..05 `retired` | resolved |
| SOL-PREC | Sol (run 3 precision notes) | CT-ISUB-14 validation spans; CT-APP-02 slice wording; CT-PSS-02/CT-TSTORE-02 reuse/observation fields; per-panel browser behaviour | CT-ISUB-14; registry fixes; section 7 UI note | resolved in v2.1 |
| RUN4-PREC | Sol and Astra (run 4 consistency notes) | `reconcileStopNotice` is asynchronous (T-03); `reconcileStopped` returns a Promise (call shapes); per-file S6e prose uses `attemptId`, the current-attempt pointer and the namespaced receipt; B2 ordering; stale "fork" wording in 3.11 | 3.9 T-03; `temporaryBoundaries.callShapes`; manifest S6e rows for `project-supervisor.ts`, `project-supervisor-store.ts`, `supervisor-conversation-store.ts`; 3.12 B2; 3.11 item 1 | resolved in v2.2 |
| UPGRADE-406 | User (via coordinator, 19:08Z) | use the latest v4: the matching 4.0.6 set is published under `latest` | section 2: exact 4.0.6 pins with provenance; transition evidence (typecheck, 869/869 baseline, harness, 8-case probe identical); S1c goes 4.0.1 -> 4.0.6; S0 4.0.1 parity unchanged | resolved |
| GATE-CPU | Coordinator (S0) | the unchanged CPU-bound deadline tests cannot run under Vitest's global async hook | 5.3 rule 3 exception: `t3.test.ts` and `t3-projection-stream.test.ts` in a separate invocation with the fatal native-resource gate; coverage excludes pending promises and fibers (none started by the exercised code); deadlines and assertions unchanged | resolved (S0) |
| UI-STORY-03-BASELINE | Coordinator (UI baseline, fixture `1e09d57`) | session revoked while a Save POST is held: the dropped POST was followed by a second POST to the same path (rejected 401 before body read) before manual re-authentication; the API helper has one `fetch` and no write replay, so the source (likely browser transport retry) is unverified | recorded as a baseline qualification for S7 and real-HTTP semantics: S7 must not add an application-level replay; whether one user action can produce two wire POSTs after a dropped connection is observed again on the S7 build; evidence `story-03-save-log.json`, `story-03-observations.json` (coordinator) | recorded |
| S0-RUN-ORCH | Sol and Astra (round 8, A-S0-R01/R02, SOL-S0-RUN-01) | `npm test` chained two watchdogs with `&&`: each got its own 20-minute deadline, and npm forwarded filters, configuration, reporters and the deadline only to the second | 5.3 rule 4: one runner owns both phases under one whole-run deadline and routes caller arguments once (configuration, file and location filters, per-phase and combined reports); runner self-tests `test/harness/phases.test.ts` | fixed (S0), recheck pending |
| SQL-406 | Astra (round 9) | exact 4.0.6 cancels a queued transaction before the holder releases (real CatalogDb probe 0.33 ms); 3.2 rule 6 and CT-SQL-01 described 4.0.5 | 3.2 rule 6 and CT-SQL-01 state the 4.0.6 behaviour (immediate return, body never runs, holder unaffected); no masking recreates the older delay; CT-SQL-01..04 are committed with S3 before catalog activation | resolved |
| R9-TEST | Sol and Astra (round 9: SOL-R9-01, SOL-R9-02, A-R9-02) | unlisted tests in slow files kept the 60 s project timeout (the 10 s check ran only after completion); failed CLI/auth assertions could render captured tokens, secret error messages and child output | 5.3 rule 2: one 10 s Vitest timeout per phase, explicit 60 s on the 55 listed tests, slow-integration project and after-the-fact check removed; token-bearing comparisons fail through `test/support/private-assert.ts` (label and redacted message only, boolean comparison for repeated tokens, child failures as status and sizes); self-tests `deadlines.test.ts`, `private-assert.test.ts` | resolved, recheck pending |
| R9-DB | Astra (round 9: A-R9-01, A-R9-03) | `src/db.ts` used synchronous node:fs; the SQLite import guard missed package subpaths | the catalog layer prepares and secures files through the injected `FileSystem`; SQL work runs untraced (`untracedSql`, plan 3.10); the guard covers the barrel and every subpath (`lint-guards.test.ts`) | resolved, recheck pending |
| SOL-FILES | Sol | 34 per-file rows reference SOL-PLAN-01..09 | each row carries the IDs in `reviewFindings` and its row change; validation lists 34/34 | resolved in v2 |
| ASTRA-FILES | Astra | 113 per-file rows reference A-P01..A-P08 and O-03 | each row carries the IDs in `reviewFindings`; slices, phases, Schema boundaries, clock domains and test phases normalized; validation lists 113/113 | resolved in v2 |
| L-01 | W4 | helper channel `scheduledTasks.upsert` is sent after awaits without a recheck (`supervisor-helper-transport.ts:235-244`) | preserved exactly; repair is a separate decision | open decision (not blocking) |
| L-02 | W4 | guide dispatch-failure replay does not recheck policy (`supervisor-team-controller.ts:560-577`) | preserved exactly | open decision (not blocking) |
| L-03 | W4 | active-chat settlement does not recheck Enable after its awaits (`supervisor-lifecycle.ts:346-404`) | preserved exactly | open decision (not blocking) |
| L-04 | W4 | bookkeeping failure after a policy commit (no notice; stale `chatEnabledAt`) | preserved and pinned by CT-LIN-03 | open decision (not blocking) |
| L-05 | W4 | a 307 response makes `fetch` POST the webhook body again to `Location` (unverified until CT-INT-03 H6 runs) | pinned by H6; D-16 keeps it | open decision (not blocking) |
| L-06 | Coordinator (early VM pilot) | unchanged VM, archived fixture `54c7e18a-ca52-498f-8467-f63c689656ff`, root `supervisor-root:9b20f073-bfdd-4d01-9dc9-7926d079de0d`, no new chat or project, model and settings unchanged. Genuine bare Start passed (source-pinned MCPX `supervision_start`, run 16; one reconciliation repeat of the stable operation; root run 6 `startRequested: true`, `objective: null`; UI active, `effectiveEnabled: true`, same root). Greeting ("Hi! Hope your day is going well.", `earlierMessages: []`): the reused root (run 7, Luna HIGH) resurrected an older CSV request from its own history and answered `needed` (Luna MAX did the same; Sol 6.1 LOW answered `not_needed` correctly); the interpretation was **rejected** (task `18f2a960` `unavailable`, `objective: null`, `agreement: null`, "The Supervisor did not return a valid, source-linked interpretation"); no introduction or contact was authorized or observed. An uncoached coding request's interpretation also carried stale CSV context and was rejected; native operative coding continued independently | two separate results: (a) the **no-contact effect boundary passed** by failing closed and stays a preserved effect invariant (A-09); (b) the **semantic `not_needed` verdict failed / is unproven** on a reused root with prior history, a model and proof limit recorded as baseline evidence, not relabelled correct, not fixed, coached or retried in this batch; the same fixture class is rerun after S6a/S6b and after S6e and compared on both (a) and (b); no positive negotiation is claimed at baseline | (a) baseline pass; (b) recorded baseline limit (coordinator evidence) |

Earlier findings: F-001 (shared guidance transaction) incorporated (3.2 rule 1, 3.4, S1);
F-002 (login DELETE journal) incorporated (3.2); F-003 (20 children) corrected; F-004 (leak
gate, watchdog) incorporated and extended by A-P05; F-005 (Vitest 5 s default) D-05;
F-006 (WAL before chmod) CC-FILEMODES; F-007 (`NodeSocket` limits) 3.6/D-09; F-008
(`effect/cli` cannot reproduce bytes) superseded by ANDREA-CLI-01 and BC-CLI-01..04; F-009
(sessionful `McpServer`) D-03; F-010/F-011 (synchronous atomicity) 3.3/3.4; F-012 (phantom
owned ID) D-21/S1b; F-013 (Stop across two files) CC-STOP-LIN; F-014 (constructor cycle)
superseded by D-23 extraction; F-015 (`pendingCandidates`) D-21; F-016 (`RpcMessage`) D-08;
F-017 (4.0.6 absent from npm) section 2; F-018 (Scanner c17ab1a) section 8; F-019 (UI
skills) prepared read-only, section 3.8; F-020 (bottom-up bridges) B-01..B-03.

Acceptance cases for the whole batch (all must hold before handoff):

- **A-01:** 863 baseline leaf tests and 6 groups pass under Vitest with identical names.
- **A-02:** no unknown send is ever resent under a new identity.
- **A-03:** Stop and Enable semantics and notices are unchanged; no fresh send is admitted
  after a Stop is ordered (CC-STOP-LIN).
- **A-04:** No Project defaults to On request and shared definitions never activate it.
- **A-05:** existing state volumes open unchanged: schemas, journal modes, file modes,
  sessions, credentials, thread identities.
- **A-06:** the CLI keeps commands, token-only successful stdout, absolute-path security and
  exit meanings; only BC-CLI-01..04 change; no token leakage.
- **A-07:** MCPX reaches `/mcp/workflows` directly, statelessly, with the same
  authentication.
- **A-08:** dashboard drafts, auth and mutations behave as in UI-STORY-01..08.
- **A-09:** a trivial request causes no Supervisor contact (effect invariant, as in the
  baseline pilot where a malformed interpretation failed closed). The semantic verdict
  limit L-06 is reported unchanged and compared on the same fixture class; it is never
  relabelled correct, and no pass is obtained by coaching or retry.
- **A-10:** no `Effect.run*` outside the allowlist, no boundary B-01..B-03 left, no ad hoc
  timers or polling, and every residual adapter is listed in section 9.
- **A-11:** every test runs under a finite runner bound with an empty leak allowlist.
- **A-12 (after S6e):** interpretation results arrive only through the typed submission
  tool; no final-chat interpretation text is parsed; the operative target always comes from the
  binding; a submission never counts as agreement; retained agreements survive the
  cut-over.
