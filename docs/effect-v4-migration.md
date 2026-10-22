# Effect v4 migration plan

Status: **plan v2**, superseding frozen v1 `14b4a875`. It reconciles Sol's terminal review
(SOL-PLAN-01..09), Astra's terminal review (A-P01..A-P08, O-01..O-06 and 113 per-file
objection rows), Astra's early auth correction, Andrea's CLI and execution directions and
Andrea's typed-interpretation, routing and model-comparison requests (3.12, proposed and
pending Sol/Astra alignment) in one ledger (section 13). No production or test port starts
until both reviewers approve this frozen revision and the coordinator confirms alignment. Owner: Opus (sole implementation owner).
Manifest: [`effect-v4-files.json`](effect-v4-files.json) (one row per baseline tracked
file; `planVersion` `v2`).

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

**Target: `effect` 4.0.5 and every Effect companion at exactly 4.0.5 (exact pins, no caret).**
Verified on 2026-10-22 (UTC) against the npm registry, GitHub releases and the installed
4.0.5 source. The coordinator registry check on the same day agrees (`latest` = 4.0.5), and
Astra's final recheck at about 17:03 UTC still reports `latest` 4.0.5 for all seven Effect
packages and 5.0.5 for Vitest.

| Package | Version | npm publish (UTC) | GitHub release (UTC) | npm integrity (sha512, prefix) | Use |
| --- | --- | --- | --- | --- | --- |
| `effect` | 4.0.5 | 2026-10-15 01:27:07 | `effect@4.0.5` 01:03:10 (tag commit `7f524e25`) | `BY4/28NlpOd99yzm…` | core, http, http-api, sql, cli, reactivity, socket, process, testing |
| `@effect/platform-node` | 4.0.5 | 2026-10-15 01:03:23 | 01:04:34 | `v4KD5fWvEUa4QmWF…` | NodeRuntime, NodeServices, NodeHttpServer, NodeSocket, NodeFileSystem |
| `@effect/platform-node-shared` | 4.0.5 (override) | 2026-10-15 01:03:16 | — | `a8rCdEkfZBGe9C6b…` | transitive (keeps the existing override) |
| `@effect/atom-react` | 4.0.5 | 2026-10-15 01:03:08 | 01:03:31 | `tqTSiy0rWBitej7k…` | React bindings |
| `@effect/sql-sqlite-node` | 4.0.5 | 2026-10-15 01:04:13 | 01:04:13 | `SHza5qNwiI4dRtUk…` | SqliteClient over `node:sqlite` (added in S3) |
| `@effect/vitest` | 4.0.5 | 2026-10-15 01:03:47 | 01:04:25 | `q64paZ/i4V2NiRhT…` | test harness (peer `vitest >=5 <6`) |
| `@effect/platform-browser` | 4.0.5 | 2026-10-15 01:03:35 | 01:03:43 | `o3H75xA91nkgIWOc…` | only if S7 adopts `BrowserKeyValueStore` |
| `vitest` | 5.0.5 | npm `latest` | — | — | runner required by `@effect/vitest` 4.0.5 |

- npm dist-tags for `effect`: `latest` 4.0.5, `staging` 4.0.5, `rc` 4.0.0-rc.118, `beta`
  4.0.0-beta.107, `prev` 3.22.3. Prereleases and v3 are excluded.
- **4.0.6 is not adoptable.** GitHub has `effect@4.0.6` (2026-10-22 03:27:53Z) and several
  companions are on npm as 4.0.6 under the `staging` tag, but `effect@4.0.6` and
  `@effect/platform-node@4.0.6` return 404 on npm. A matching set does not exist. S0
  re-checks the registry; moving to 4.0.6 later needs all companions under `latest` and a
  ledger entry.
- Official guidance used, pinned to the 4.0.5 tag commit `7f524e25cfb4`: `MIGRATION.md`,
  `LLMS.md`, `migration/{services,layer-memoization,error-handling,runtime,scope,forking}.md`
  and the `ai-docs/src` examples for layer composition, `NodeRuntime.runMain`,
  `@effect/vitest` (`it.effect`, `it.live`, `layer`), SQL, HttpApi server/testing and CLI.
  No v3 or beta examples are used; v3 shapes (`Context.Tag`, `Effect.Service`, `Either`,
  `Effect.catchAll`, `effect/unstable/*` paths, `@effect/platform`, `@effect/sql`) are banned.
- Relevant 4.0.2–4.0.5 release notes: every export now declares `@stability` (#8770);
  `Effect.retry` no longer retries defects/interruptions (#8799); `Cache.get` interruption
  race fixed (#8837); `FileSystem.open({noFollow})` (#8900); MCP HTTP fixes (#8888, #8890,
  #8924, #9151); `Path.resolveWithin` (#9127); `FileSystem.File.Info` 64-bit fields are now
  `bigint` (#9112); SQLite statements borrow the shared connection under the semaphore with
  failed-COMMIT recovery (#9134); HTTP spans redact sensitive query values and URL
  credentials (#9136); `Redacted` URL params (#9160); infinite atom rebuild fix (#9105).
- 4.0.6 fixes that 4.0.5 lacks and the plan must guard explicitly: effect atoms can drop
  the latest exposed success when an async run fails (#9607); replacing an atom runtime
  layer through registry initial values drops Reactivity/global layers (#9313);
  `Effect.callback` retains completed suspension state until GC (#9499);
  `cachedInvalidateWithTTL` can cache a stale result (#9617, not used by this plan).

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

- **Entries.** From S3 (with the CLI port), `src/main.ts` exports the server program and
  calls `NodeRuntime.runMain` only when it is the process entry (`import.meta.main`,
  Node ≥ 24.2), so `node dist/main.js` (Dockerfile `CMD`, `npm start`) and
  `t3-supervisor start` run the same program under exactly one `runMain`; until then the
  unported `start` keeps importing `main.ts`, whose top-level `runMain` stays as today. The
  other entries are `src/cli.ts`, `scripts/probe-t3.ts`, `scripts/run-tests.ts` and
  `ui/src/main.tsx`.
- **CLI (Andrea: Effect end to end, `effect/cli` extension points first; S3).** `src/cli.ts` is
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
6. Acquisition is protected (`SqlClient.ts:417-449`, `uninterruptibleMask`): interrupting a
   fiber that waits for the connection completes only after the current holder releases,
   and its body never runs. Cancellation is bounded by a short local holder, not immediate,
   which is why transactions stay short and contain SQL only.
7. A failed COMMIT is rolled back under the semaphore before the connection is reused;
   nested `withTransaction` failures roll back to their SAVEPOINT.

Target-regression SQL tests on the real driver (S3 for CatalogDb/AccessDb, S6d for
GuidanceDb/PolicyDb): **CT-SQL-01** an interrupted waiter completes only after the holder
releases and its body never runs; **CT-SQL-02** interruption inside a body rolls back and
the connection is reusable; **CT-SQL-03** a failed COMMIT is cleaned up and the next
transaction succeeds; **CT-SQL-04** two independent clients on one file in different
processes keep CAS (`UPDATE … AND revision=?`) and grant consumption correct under
BEGIN IMMEDIATE.

| File | Owner | Journal | Guarantees | Client | Slice |
| --- | --- | --- | --- | --- | --- |
| `catalog.sqlite3` | `store.ts` | WAL | `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=256`, `secure_delete=ON`, `max_page_count`; dir 0700, db/-wal/-shm 0600 | `CatalogDb`; file created and chmodded 0600 before open, pragmas after open; process lifetime | S3 |
| `access/login.sqlite3` | `service-auth.ts` (server and `auth forge`) | **DELETE** (validated) | `synchronous=FULL`, `busy_timeout=5000`, `max_page_count`; exactly two STRICT tables; caps/TTL; `quick_check`; O_NOFOLLOW + dev/ino identity before open and lstat re-check after open; size bounds; CLI never bootstraps | `AccessDb` = `SqliteClient.make({disableWAL: true})` after the private-files checks: **one client for the lifetime of the dashboard HTTP server** shared by every login/session/revocation operation (baseline `createServiceAuth`, `service-auth.ts:420-528`, opened at `guidance-ui.ts:144` and closed with the server at `:333/:348`; re-acquired with the server after a degraded supervision restart, released after the server's listeners), and **one short-lived client per forge operation in the separate CLI process** (`forgeDashboardToken`, `:530-566`). Never two clients in one process: a second client's synchronous busy wait would block the event loop while the first is suspended inside a transaction (Astra's 4.0.5 probe: `harness-probe/auth-client-contention`, LockTimeoutError after 53 ms). Cross-process contention stays BEGIN IMMEDIATE + `busy_timeout` (CT-AUTH-05, CT-SQL-04) | S3 |
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
| S3 | `Store` (`CatalogDb`), `ServiceAuth` (`AccessDb`), CLI (`auth forge` calls `ServiceAuth`) |
| S4 | native envelope, `T3Client` + projection stream, `SupervisorNative`, `ProjectFiles`, `GitProbe`, probe script |
| S5 | `ProjectDefinitionLoader`, `ProjectConfigEditor` |
| S6a | extraction commits; pure modules; `ScopeLocks`; `SupervisionGate` (+ admission, 3.11); `HelperTransport`; `TeamRuntime` |
| S6b | `SupervisorConversation` → `SupervisorLifecycle` → `SupervisionControl` → `WorkflowWriteController` → `SupervisorTeamController` → `ProjectSupervisor` → `WorkflowProgress`, team view, dashboard overview |
| S6c | `GuidanceRuntime`, MCP route, HTTP handlers/router/auth routes/static, `SupervisionLive` (replaces `runGuidanceApplication`) |
| S6d | `GuidanceDb`/`PolicyDb` engine switch (all callers already ported) |
| S6e | typed interpretation submission (3.12; owner proposal pending alignment) |
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
| B-03 | Promise facades `(args, signal) => run(service.op(args), signal)` for each ported service an unported caller still uses (e.g. catalog, `T3Client.projection`, `ServiceAuth`, `ProjectDefinitionLoader`, `HelperTransport`), passed through existing constructor parameters instead of being constructed inside the unported class | composition root | the slice that ports the last unported caller; all by S6c |

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
   policy saves; the sections contain only synchronous store work and a fork.)
   - Stop, Enable, thread-policy saves, dashboard chat-supervision changes and Start
     activation run inside it: policy commit, then the guidance bookkeeping (start
     rejection, unbound stop, `setSupervisionStop`, `setStopNotice`,
     `fenceStoppedSupervision`, `recordChatEnable`).
   - Every fresh send path runs its final guard (authoritative policy and guidance reads,
     scope enabled, actor/assignment and receipt checks), its durable receipt commit and its
     **native admission** inside it.
   - Native admission is the linearization point of a send: the native call is forked into
     the owning `FiberMap` with its final identity, inside the section. The section ends
     immediately after admission; the caller awaits the call outside it. No lock is held
     across socket open, a reply or a body read, and no SQL transaction spans two files.
     The existing per-scope `serial` queue (`project-supervisor.ts:119-123`, `ScopeLocks` in
     the target) spans network work and is not the admission lock.
   - After admission, Stop never interrupts the call. Caller interruption (the 120 s cycle
     deadline, request abort, shutdown) aborts it locally exactly where today's
     `AbortSignal` does; the outcome is classified by the sent boundary and reconciled,
     never replayed under a new identity.
2. **Masking and order.** Each section body runs under `uninterruptibleMask` around
   commit + bookkeeping and around receipt commit + admission; an interruption before the
   guard admits nothing. Acquisition order: `ScopeLocks` key (if held) → admission section →
   database critical section (`Effect.sync` before S6d, `withTransaction` after). The
   section is never acquired inside a transaction.
3. **Outcomes.** A Stop ordered before a send's admission makes its guard fail: zero fresh
   sends, and the path's baseline guard-failed state. A send admitted before the Stop keeps
   its original identity, is not cancelled or replayed, and reconciles to one outcome; Stop
   then produces exactly one operative notice, as today. Stop/Enable/Stop keeps the
   baseline notice rules (`supervisor-conversation.ts:1720`, `project-supervisor.ts:
   912-915`).
4. **Preserved baseline limitations (not widened, not fixed in this batch).** A crash
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
for the other paths and CT-LIN-05 (final guard → native admission with a parked adapter and
a concurrent Stop) are `target-regression`.

### 3.12 Typed interpretation submission and routing (CC-INTERP-SUBMIT; proposal pending alignment)

IDs: ANDREA-ITOOL-01, ANDREA-ROUTE-01, ANDREA-ITOOL-EVAL-01, ANDREA-MODEL-01. Status: owner
proposal aligned with Sol's working recommendation; pending Sol/Astra terminal alignment.

Andrea asked to replace free-form final-chat JSON interpretation parsing with a typed
Supervisor MCP submission tool validated with `Schema`, keeping exact native identity,
source, run and binding authority, with no T3 change, no permanent fallback and no
duplicate store; and asked whether the tool could also dispatch to the right thread. The
published `message.dispatch` has no `outputSchema`, so the final message cannot be typed
natively. Baseline path (`project-supervisor.ts:1262-1483`): `processProject` dispatches
the interpretation request to the bound root (`message.dispatch`, `commandId
supervisor-objective:<taskId>`, `:1360-1362`); `reconcile` waits for that run to complete,
`JSON.parse`s the last assistant message (`:1440-1450`, `parseInterpretation` /
`parseWorkflowInterpretation`, `supervisor-workflow.ts:68,1467`), revalidates definitions
and source, then applies the result and any Start activation in one transaction
(`:1466-1474`); the same cycle introduces an `inferred` task through the existing
conversation path (`:1297-1299`). The early pilot (L-06) failed exactly at the
`JSON.parse` step (one missing closing brace) and failed closed. The coordinator's
read-only comparison with the original Codex provider JSONL shows identical lengths and
hashes, so the braces are missing in the model output itself, not truncated by the T3
projection; the same happened with GPT-6.1 Sol LOW on a coding plan. Model choice alone does
not remove the dependence on free-form final-chat syntax; the typed tool does.

**Recommendation (aligned with Sol's working recommendation): the tool records a
source-bound result, wakes the existing reconciler and returns immediately; it never sends
and never waits for its own run.** Delivery stays service-owned on the existing durable
path.

1. **Tool.** `supervision_interpretation_submit` on the existing `/mcp/workflows` endpoint
   (same bearer, Host/Origin and stateless SDK adapter, 3.7). Arguments:
   `supervisorThreadId`, `bindingGeneration`, `interpretationId` (the task ID quoted in the
   request envelope), `sourceMessageIds`, `objective`, `reason`, and, by the task's state,
   `supervision` + `workflow` (definition context present) and `startRequested` (the task
   is the pending Start's task). No target, thread or route argument exists; any excess
   field is rejected (`onExcessProperty: "error"`).
2. **Authority.** Reuse `findToolEvidence`/`verifyWorkflowToolEvidence`
   (`workflow-write-evidence.ts:207-275`) with a new evidence tool kind: an executed,
   strong, main-run `dynamic_tool` item of the bound root with canonically equal raw
   arguments, **plus** `evidence.runId` must be the run whose `userMessageId` is the task's
   `messageId` (the dispatched interpretation request). The binding (`projectId`, main,
   root, generation) is resolved from the task, never from caller-supplied IDs; the
   locator fields must merely equal it.
3. **Decode.** One `Schema` per variant; the existing semantic validators
   (`parseInterpretation`/`parseWorkflowInterpretation` rules, `validateWorkflowPlan`,
   size limits) run on the decoded value. Invalid input returns `invalid` with typed
   diagnostics and records nothing, so the model can correct and resubmit inside the same
   run. The advertised `inputSchema` is generated once with `Schema.toJsonSchemaDocument`
   (`Schema.ts:17040`) and pinned by a golden test.
4. **Commit (write-once receipt).** One `GuidanceDb` transaction (S6e follows S6d; the
   admission section of 3.11 is not needed because nothing is sent) checks that the task is still `dispatching`,
   `waiting` or `uncertain` for that `messageId`, the binding generation is current, the
   scope is enabled for interpretation (a valid pending Start counts, as in
   `scopeEnabled(..., "interpretation")`), and the source is current
   (`currentSource`, `:1393-1402`); it then stores `interpretationSubmission`
   `{runId, itemId, argumentsHash, rawArguments, decoded, receivedAt}` on the existing task
   record. Identical replay returns the same receipt; different content for the same
   `interpretationId` returns `conflict` and keeps the first. Stopped scope or stale source
   returns `denied`/`stale` and records nothing. A pending Start needs only this exact
   submission allowance; nothing is activated at submission time. After the commit the tool
   signals the scope's reconciler wake (below) and returns at once: `recorded` (with "this
   is an interpretation, not an agreement"), `duplicate`, `pending` (evidence not yet
   visible within the existing 400 ms evidence budget), `invalid`, `stale`, `denied`,
   `conflict`. It never awaits run completion: the run cannot finish while its own tool
   call waits.
5. **Wake.** A recorded submission signals the scope's wake; until that task's run is
   terminal the scope rechecks on a short `Schedule` (250 ms, bounded by the existing 300 s
   interpretation limit) instead of the 5 s spacing, so application and introduction
   follow the run's end closely. The wake only shortens latency; correctness never depends
   on it.
6. **Apply (existing path).** `reconcile` keeps its run-terminal gate, source,
   boundary and definition revalidation and the Start activation transaction; it reads the
   recorded submission instead of the last assistant message. A completed run without a
   recorded submission closes `unavailable` ("did not submit a valid, source-linked
   interpretation"); a failed, cancelled or rolled-back run discards the submission. The
   final-message `JSON.parse`, fence stripping and string parsers are deleted; no fallback.
7. **Proposal evidence switches together.** Every caller that reparses the root's final
   interpretation text as proposal evidence moves to the recorded submission in the same
   commit series, with no dual path: `supervisor-conversation.ts:1801-1830`
   (`interpretationMatches`, `interpretationEvidenceCurrent`, `interpretationCandidate`)
   compare the plan with the decoded submission and treat evidence as current only while
   the native tool item (by `itemId`, re-read with `getTurnItem`) is still executed, not
   rolled back, in the same run, with an unchanged canonical-argument hash.
8. **Routing.** The operative target is always the bound main of the task's binding.
   An applied `inferred` task is introduced by the existing conversation path
   (receipt-first, admission section, Stop fence, unknown-send reconciliation, CC-STOP-LIN).
   The tool never calls `message.dispatch`: sending inside a 9 s MCP call would couple an
   unknown native outcome to a tool response the model may retry, and would bypass the
   admission and receipt contracts.
9. **Agreement boundary.** A recorded or applied submission is an interpretation and at
   most a proposal; operative agreement still needs the existing exact operative
   acceptance records. Nothing marks an agreement from the submission.
10. **Prompt.** The interpretation request tells the root to call the tool exactly once with
   the quoted `interpretationId` and not to reply with JSON; the root must have the
   Supervisor MCP server available (deployment gate, see blockers).

**Interpretation of "could the tool dispatch?"** Read as: typed submission followed by
service-owned routing and delivery to the bound operative. A materially different reading,
letting the model choose or trigger a target, is rejected: targets come only from the
binding, and the send stays on the receipt/admission path. The speed gain comes from the
wake (item 5), not from sending inside the tool.

Blockers before implementation (S6e): (B1) Sol/Astra alignment on this design; (B2) the
coordinator confirms the bound roots on both hosts reach the Supervisor MCP tool (MCPX)
with the same bearer; (B3) the tests below are accepted as the contract; (B4) the existing
tests coupled to final-text parsing (in `supervisor-workflow.test.ts`,
`project-supervisor.test.ts`, `project-supervisor-workflow.test.ts`,
`supervisor-conversation.test.ts`, `supervisor-workflow-agreement.test.ts`,
`workflow-write-controller.test.ts`) keep their names where the intent survives (their
fixtures produce tool items instead of assistant JSON); any leaf that only tested
fence/JSON-syntax handling is replaced and listed by name in the S6e ledger (A-01 holds
through S6d). Optional ideas are listed after the evaluation table below.

Tests (`new-behaviour`, S6e): CT-ISUB-01 valid submission in the exact interpretation run →
recorded → applied once at run completion → one introduction to the bound main via the
existing path; CT-ISUB-02 authority: other thread, subagent child, earlier root run,
argument mismatch, truncated or rolled-back item → nothing recorded; CT-ISUB-03 no
model-chosen target: excess `targetThreadId`/route fields rejected, delivery only to the
binding's main; CT-ISUB-04 idempotency: identical replay, conflicting replay, replay after
apply, lost MCP response then retry; CT-ISUB-05 Schema/semantic invalid inputs return
diagnostics and allow an in-run resubmission; CT-ISUB-06 source freshness at submission
and at apply; CT-ISUB-07 pending Start: `startRequested` true activates, false rejects,
missing is invalid, Stop or supersede before apply prevents activation; CT-ISUB-08 Stop
before submission (denied), between submission and apply (not applied), during
introduction (CC-STOP-LIN); CT-ISUB-09 completed run without submission → `unavailable`,
and a well-formed final-chat JSON is ignored; CT-ISUB-10 run failed/rolled back after
submission → discarded; CT-ISUB-11 restart between submission and apply → applied once;
CT-ISUB-12 no-contact: greeting → objective null or `not_needed`, no introduction;
CT-ISUB-13 submission never creates agreement; CT-ISUB-14 latency timestamps recorded
(dispatch admitted, root run start, submission recorded, run terminal, apply,
introduction admitted); CT-ISUB-15 the tool returns before its run completes and the wake
applies the result without waiting for the 5 s spacing; CT-ISUB-16 conversation proposal
evidence follows the recorded tool item (rolled-back or changed item → evidence not
current), never final text. CT-INT-01 gains the same tool through the authenticated route
after S6e.

**Other model-to-service structured results (ANDREA-ITOOL-EVAL-01, evaluation only).**
Andrea approved exactly one new tool. The other contracts where the service reads a
model's structured result were checked against the baseline; no other tool is added, and
none of this blocks the migration.

| Contract (producer → reader) | Existing typed path | Demonstrated failure or risk | Recommendation |
| --- | --- | --- | --- |
| Interpretation result incl. pending-Start verdict (root → `project-supervisor.ts:1433-1474`; proposal evidence in `supervisor-conversation.ts:1801-1830`) | none: final-chat JSON | demonstrated: missing final brace (Luna HIGH greeting and coding, Sol 6.1 LOW coding), confirmed in provider JSONL; failed closed | **needed — approved**: `supervision_interpretation_submit` (this section) |
| Workflow proposal and operative acceptance records (Supervisor ↔ operative chat, fenced JSON, `supervisor-workflow-agreement.ts:40-76`) | none for the records; `workflow_write`/`workflow_read` are typed for state edits | not demonstrated (the pilot never reached negotiation); malformed records already surface as `record_json_invalid` and are repaired in dialogue; records must stay visible to the human and be authored by the operative | **possible-needed**: decide only from post-S6e pilot evidence (malformed-record rate, negotiation latency); no tool now |
| Project definition decision (operative → `supervisor-definition-review.ts:176-230`, fenced JSON) | none | not demonstrated; malformed fences are ignored, so the decision stays pending (fail closed) | **possible-needed**: same evidence rule; no tool now |
| Helper check-in and readiness completion (helper → `supervisor-team-runtime.ts:383-391, 568-572`) | `supervision_team` (`register`, `ready`, `report`, `review_handover`, `note`, …) carries the structured content | exact completion marker only (no JSON); a missing marker fails closed | **keep** |
| Team assignment, quarantine, guidance and reports | `supervision_team`, `supervision_guide` with native proof | none | **keep** |
| Workflow edits and assessment | `workflow_write`/`workflow_read`; assessment derived from the state document (`workflow-assessment.ts`) | none | **keep** |
| Start and Stop requests | `supervision_start`/`supervision_stop` with native proof | none (pilot: Start and Stop succeeded with exact proof) | **keep** |
| Activity monitoring (`supervisor-monitor.ts`) | native event observation, not a model result | none | **unnecessary** |

Essential for interpretation and routing (blockers B1–B4 above, plus Sol's two
conditions: the tool never waits for its own run, and every final-text proposal-evidence
caller switches together). Optional future ideas, not planned: typed agreement or
definition-decision records if pilot evidence shows a real failure rate; generating every
MCP input schema from `Schema`; an ephemeral interpretation thread against history
contamination.

**Model comparison (ANDREA-MODEL-01, coordinator evidence; D-28).** On the owned fixture
class, without coaching and without changing global defaults, the coordinator compares
GPT-6 Luna MAX and GPT-6.1 Sol LOW (current Luna HIGH pilot observations kept separately
labelled) on the same cases: bare Start, greeting (no-contact effect and semantic verdict
separately), substantive coding request, reused-root history contamination
(`earlierMessages: []`), Stop during interpretation. Correctness: valid and source-linked
result, correct verdict, no resurrected earlier request, effects as expected. Speed:
interpretation latency (dispatch admitted → root run start → result → task applied) and
negotiation latency (introduction admitted → exact operative acceptance), from native
event timestamps; coding and npm durations are excluded. Measured on the baseline
final-JSON path now and again after S6e. Baseline observations so far, same retained root (Luna MAX
pending): greeting — Sol 6.1 LOW correct `not_needed` in 3.019 s, Luna HIGH 16.509 s with the
stale CSV request resurrected (rejected); bare Start root latency — Sol LOW 7.777 s, Luna HIGH
9.114 s; coding plan — Sol LOW 17.576 s but the final outer brace missing (failed closed, no
introduction), Luna HIGH also missing a brace. Sol 6.1 LOW becomes the default only if the
evidence shows equal or better correctness on every case and lower latency; until then
models, defaults and settings stay unchanged.

## 4. Cross-file contract map

Full invariants, participants (derived from manifest rows, each row tagged) and pins are in
`effect-v4-files.json` under `contracts`; `CC-STOP-LIN` also carries the 18-path table and
the policy commit list.

| ID | Owner | Slice | Invariant (first clause; full text in the manifest) | Pins |
| --- | --- | --- | --- | --- |
| CC-AUTH | `src/service-auth.ts` | S3 | login.sqlite3 journal_mode DELETE, exactly two STRICT tables, caps of 32 grants/sessions, grant consume + session insert in one BEGIN IMMEDIATE, O_NOFOLLOW + dev/ino identity checks, fchmod 0600/0700, link()-based … | service-auth.test.ts, auth-cli.test.ts, CT-AUTH-01..04, CT-AUTH-05 |
| CC-BINDING-GEN | `src/project-supervisor-contract.ts` | S7 | UI and API results are applied only to the exact project/main/binding generation that requested them. | CT-UI-PS-02, project-supervisor-ui tests |
| CC-BINDING-MERGE | `src/project-supervisor-store.ts` | S6d | stale full-document binding writes keep the stored stopNotice/supervisionStop | CT-LIFE-02 |
| CC-CATALOG | `src/store.ts` | S3 | Store service shape unchanged | store.test.ts, t3 watch tests, CT-STORE-01..03 |
| CC-CLI | `src/cli.ts` | S3 | commands start and auth forge with --data-dir | auth-cli.test.ts, CT-CLI-01, CT-CLI-02, CT-CLI-03, CT-CLI-04, CT-CLI-BIN-01, CT-CLI-BIN-02, CT-CLI-BIN-03 |
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
| CC-INTERP-SUBMIT | `src/project-supervisor.ts` | S6e | interpretation results arrive only through supervision_interpretation_submit, which records and returns immediately (never awaiting its own run) and wakes the scope reconciler | CT-ISUB-01, CT-ISUB-02, CT-ISUB-03, CT-ISUB-04, CT-ISUB-05, CT-ISUB-06, CT-ISUB-07, CT-ISUB-08 |
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
| CC-STOP-LIN | `src/project-supervisor.ts` | S6a | policy reads stay authoritative database reads (no snapshot) | CT-LIN-01, CT-LIN-02, CT-LIN-03, CT-LIN-04, CT-LIN-05, CT-LIN-06, CT-PS-09, CT-INT-03 |
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
   explicit per-test options from the start): `testTimeout` 10 s for deterministic
   service and pure cases; a named `slow-integration` class at 60 s per test, listed by
   file and title from the S0 timing report (every case that took over 2 s on either the
   owner's or Astra's run); `hookTimeout` and `teardownTimeout` 30 s. The values are
   finalized from S0 evidence in the S1c commit. Tighter product and test deadlines stay,
   including projection-stream 5000 ms. After a failure, no retry, no timeout increase and
   no re-run is used to obtain green; a timeout change is a ledger item with evidence.
3. **Leak gate:** `detectAsyncLeaks: true` plus `test/support/leak-gate.ts`, a reporter
   that fails the run on any leak not in the baseline allowlist. It reads
   `vitest.state.leakSet`, an internal field, acceptable only because Vitest is pinned
   exactly; it fails closed if the field is missing. Each allowlist entry names the
   resource kind, the creating source location, the test file, a maximum count and the
   removing slice (not a fungible per-file count). S8 requires an empty allowlist.
4. **Outer watchdog (tooling adapter, O-03).** `npm test` runs `scripts/run-tests.ts`, an
   Effect program (`effect/process` `ChildProcess` with `NodeChildProcessSpawner`) that
   starts `vitest run` in its own process group under a 20-minute whole-run deadline (about
   6× the 196 s baseline) and on expiry sends TERM to the group, then KILL after 10 s, and
   exits 124. CI adds `timeout-minutes: 30`. It is deliberately a separate process
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

The registry holds 199 entries: the 157 v1 IDs (phased by W5 from the baseline code) plus 42
new ones (CT-INT, CT-LIN, CT-SQL, CT-AUTH-05, CT-CLI-BIN, CT-PROBE-T3, CT-CLOCK-01,
CT-REDACT-01, CT-UI-EDITOR-01, CT-UI-SETUP-01). Dispositions: 185 keep, 7 consolidated into
another ID, 7 covered by an existing test. Phases: 155 `s1-baseline`, 7 `s0-parity`, 15
`target-regression`, 16 `new-behaviour`, 4 `s1c-transition-golden`, 2 `known-failure`. 79
kept cases also carry a separate post-port `targetRegression` variant.

**S1 (`s1-baseline`, 151 kept cases, unchanged source, baseline dependencies):**

| Kind | IDs |
| --- | --- |
| atomicity-restart | CT-AUTH-01, CT-AUTH-05, CT-CONV-04, CT-CSTORE-03, CT-GDB-01..02, CT-GDB-05, CT-MSTORE-01, CT-PS-02, CT-PS-07, CT-PSS-01, CT-PSS-04, CT-PSS-07..08, CT-RESET-01, CT-STORE-01..02, CT-TRUN-03, CT-WSS-01, CT-WSS-03, CT-WWC-04..05 |
| characterization | CT-APP-01, CT-APP-03, CT-AUTH-02, CT-AUTH-04, CT-CONFIG-01..03, CT-CONV-08..09, CT-CSTORE-04, CT-FILES-02, CT-GDB-06, CT-HEALTH-01, CT-HTX-04, CT-LIFE-03, CT-MAIN-03..04, CT-MCP-02, CT-MCP-04..05, CT-NATIVE-03, CT-PD-03, CT-POLICY-02, CT-PROBE-T3-01..02, CT-PROBE-T3-05, CT-PS-10, CT-PSS-03, CT-PSS-05..06, CT-REDACT-01, CT-STORE-03, CT-SW-01, CT-SWA-01, CT-T3-04..05, CT-TCTRL-05, CT-TRUN-04, CT-UI-04, CT-UI-06..07, CT-WP-02, CT-WSC-01, CT-WSFRAME-01, CT-WSS-04, CT-WWC-06 |
| cli | CT-CLI-01..04, CT-CLI-BIN-01 |
| interruption | CT-CLI-BIN-02..03, CT-CONV-01..03, CT-EDITOR-02, CT-HTX-01, CT-LIFE-01, CT-MAIN-01, CT-MAIN-05, CT-MCP-03, CT-PD-02, CT-PD-04, CT-PROBE-02, CT-PROBE-T3-03, CT-PS-09, CT-T3-03, CT-T3-06, CT-TCTRL-01, CT-TRUN-01, CT-UI-05, CT-WWC-01 |
| native-authority | CT-INT-01..02, CT-MCP-01, CT-TCTRL-04, CT-WWC-08, CT-WWE-01 |
| no-contact | CT-CONV-07, CT-PROBE-T3-04, CT-PS-08, CT-TRUN-05 |
| race | CT-CONV-06, CT-EDITOR-01, CT-LIFE-02, CT-LIN-01..04, CT-LIN-06, CT-PD-01, CT-POLICY-01, CT-PROBE-03, CT-PS-03..05, CT-T3-01, CT-TCTRL-02, CT-TRUN-02, CT-UI-PS-02, CT-UI-SETUP-01, CT-WP-01, CT-WSS-02, CT-WWC-02 |
| resource | CT-APP-02, CT-FILES-MODE-01, CT-HTX-03, CT-PS-11, CT-T3-02 |
| ui-draft-auth | CT-AUTH-03, CT-PSC-02, CT-UI-01..03, CT-UI-AUTH-01, CT-UI-EDITOR-01, CT-UI-NOPROJ-01, CT-UI-OVERVIEW-01, CT-UI-PS-01, CT-UI-SHELL-01, CT-UI-START-01 |
| unknown-send | CT-CSTORE-01, CT-FILES-01, CT-GDB-04, CT-INT-03, CT-NATIVE-01..02, CT-PS-01 |

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
CT-GDB-03 (S6d), CT-LIN-05 (S6a, S6b), CT-MAIN-02 (S2), CT-MSTORE-02 (S6d), CT-PSS-02 (S6d),
CT-SQL-01 (S3, S6d), CT-SQL-02 (S3, S6d), CT-SQL-03 (S3, S6d), CT-SQL-04 (S3, S6d),
CT-TSTORE-01 (S6d), CT-TSTORE-02 (S6d), CT-WWC-07 (S6b).

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
| S1 | `s1-baseline` wave (5.4) on the unchanged source and baseline dependencies (effect 4.0.1), including the recorded `s1c-transition-golden` outputs | all S1 tests green; **coordinator's baseline VM pilot recorded (section 7); entry gate of the implementation campaign** |
| S1b | D-21: red run of CT-TCTRL-03 recorded as evidence, then the separately reviewed minimal fix with the test | red-then-green evidence; full suite green |
| S1c | Exact 4.0.5 pins for `effect` and companions, `@effect/vitest` 4.0.5; finite runner bounds (5.3 rule 2); Effect timeout self-test; compile-only API probe; concise AGENTS.md rule (section 10) | parity 863/863 and every S1 test unchanged and green on 4.0.5 (transition proof); goldens identical; harness; registry recheck; Docker build |
| S2 | `SupervisorConfig`, `Redacted` token files, JSON `Logger`, typed errors, `SupervisorIds`, elapsed-clock helper, server program in `main.ts` (still started by today's top-level `runMain` until S3), health/status in `supervisor.ts`, root `ThreadPolicy`/`SupervisorOwnership` services, boundary B-01 | CT-CLI-BIN-02 (start signals), CT-MAIN, CT-HEALTH, CT-CONFIG, CT-REDACT-01; no `process.exitCode`, `process.env` or `process.on` outside the config and entry modules |
| S3 | `src/db.ts`; `catalog.sqlite3` (`store.ts`) and `login.sqlite3` (`service-auth.ts` server-lifetime client + forge per-operation client); CLI on `effect/cli` (after ServiceAuth, which `auth forge` calls), with `main.ts` switching to the `import.meta.main` entry guard in the same commit | per-DB pragma/schema/mode tests; DELETE journal and identity tests; CT-AUTH-05; CT-CLI-BIN-01/03 with BC-CLI expectations; CT-SQL-01..04 for these files; Docker build |
| S4 | Native envelope (D-08 spike), `t3.ts`, projection stream, `supervisor-native.ts`, `project-files.ts`, `git-probe.ts` (guidance writes in `Effect.sync` sections), `scripts/probe-t3.ts` | real-ws frame/limit/close/interrupt tests; unknown outcomes; CT-CLOCK-01; CT-PROBE-T3; VM native read probe |
| S5 | `definition-references.ts` (pure), `project-definitions.ts`, `project-config-editor.ts` | YAML Schema diagnostics goldens; editor uncertain/never-retried mapping |
| S6a | Extraction of `SupervisionGate` and `SupervisionControl` on Promise code (3.9); pure modules (IDs injected into `supervisor-workflow.ts` builders); `ScopeLocks`; `SupervisionGate` with the admission section (3.11); helper transport; team runtime | extraction commits pass the full S1 suite unchanged; CT-LIN for helper paths; no `runPromise`, timers or promise chains left in these modules |
| S6b | Conversation, lifecycle, `SupervisionControl`, write controller, team controller, project supervisor, workflow progress, team view, dashboard overview server part | receipts, CAS, unknown-effect, Stop and CT-LIN tests; No Project default; golden identity tests; coordinator reruns the S1 pilot journeys |
| S6c | `guidance.ts`, `guidance-contract.ts`, MCP route with the SDK adapter, HTTP handlers/router/auth routes/static, `SupervisionLive` replacing `runGuidanceApplication`; B-01 and all B-03 deleted | status/body matrix, CSRF/Host/Origin/session, MCP auth/protocol/abort/close; no `Effect.run*` outside the allowlist; VM MCPX direct |
| S6d | `GuidanceDb` for `guidance.sqlite3`, `PolicyDb` for `thread-settings.sqlite3`; all stores become Effects; critical sections become `withTransaction`; CC-GDB-IMPLICIT wrapped; ownership preload from the guidance layer; B-02 deleted | S1 atomicity tests green on the new engine; CT-SQL-01..04 for these files; no `node:sqlite` import outside the SQL layer and PrivateFiles adapter; Docker build; VM cut-over |
| S6e | Typed interpretation submission (3.12): `supervision_interpretation_submit` on `/mcp/workflows`, evidence kind bound to the interpretation run, write-once submission on the task record, `reconcile` applies it, final-text parsers deleted, prompt updated; coupled test fixtures produce tool items | CT-ISUB-01..16; CT-INT-01 through the tool; no `JSON.parse` of model text left; coordinator reruns the pilot journeys and the model comparison |
| S7 | UI on Atom/AtomHttpApi following 3.8 (Modern Web Guidance → Impeccable → WCAG) | atom tests; replay of UI-STORY-01..08 by the coordinator; Docker build |
| S8 | Remove superseded machinery; final lint bans (`Effect.run*` outside the allowlist, `setTimeout`/`setInterval` in `src`, `ws`/`node:sqlite`/`loadExtension` outside approved adapters); empty leak allowlist; README update | full suite, harness, build, Docker build; handoff to the coordinator for both-host deployment |

Order inside each slice follows the manifest (`order`). File counts per slice are in the
manifest `summary.slice`.

v1 → v2 mapping: v1 S0 → S0 (Vitest only) + S1c (4.0.5 transition, after S1); v1 S1 → S1 +
S1b; v1 S2 → S2 (the CLI moves to S3); v1 S5 (HTTP, MCP, composition) → S6c;
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
   start from that commit in isolated worktrees (harness-managed `isolation: "worktree"`;
   uncommitted edits are never relied on), implement against the frozen interfaces with
   test layers, and commit on their own branch.
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
| S1 | `test/support` fixtures (production wiring, fake T3 peer, bin harness); CT-LIN suite; S1b D-21 fix | CT-INT suites; CLI-BIN + PROBE-T3 + CLI cases; per-suite characterization additions in 3 disjoint suite groups |
| S1c | dependency transition, finite bounds, AGENTS.md | none |
| S2 | `main.ts`, `supervisor.ts`, root services, B-01 | foundation services (`config.ts`, `types.ts`, redaction, IDs, logger, errors) |
| S3 | `src/db.ts` (four interfaces) | catalog store; access store + CLI |
| S4 | native envelope + D-08 spike | `t3.ts` + projection stream; `supervisor-native.ts`; `project-files.ts` + `git-probe.ts`; probe script |
| S5 | interface review | definitions loader + config editor |
| S6a | extraction commits, `SupervisionGate`/admission, `ScopeLocks` | pure modules; helper transport → team runtime |
| S6b | frozen service interfaces; every admission/critical-section call site review | conversation + lifecycle; write controller + team controller; control + project supervisor + progress + team view + overview |
| S6c | composition (`SupervisionLive`), boundary deletion | `GuidanceRuntime`; MCP route; HTTP handlers/router |
| S6d | `GuidanceDb`/`PolicyDb` layers and every caller's `withTransaction` | store files in disjoint groups with their store suites |
| S6e | submission authority, commit and apply (`src/interpretation-submission.ts`, `reconcile`), prompt | MCP tool wiring + golden schema; fixture conversion of the coupled suites in disjoint groups |
| S7 | AtomHttpApi service, registry, mutation/draft families, `access.ts`, `api.ts` | project supervisor panels; definitions/editor panels; shell, navigation, No Project, overview |
| S8 | cleanup, bans, README | none |

## 7. Live proof (local coordinator only)

The remote owner cannot claim Mac or VM results. The coordinator runs these on the Lima VM
with existing fixtures, explicit IDs and budget; only owned idle fixtures are cleaned up.
No seeded agreements, no protocol coaching, no first-tool barrier claims, no replay of
historical closed requests, and the no-contact Stop behaviour stays unchanged.

- **S1 gate, on the baseline image, before any production port (SOL-PLAN-07, A-P01).**
  - One bounded **uncoached operative request** on an owned fixture chat through the real
    controller and native transport. Record raw rendered prompts, actual tool arguments,
    native source/run/event timestamps, total traffic and repeated messages, and first
    edit, introduction and completed acceptance separately. Timing is advisory; unmodified
    T3 has no pre-first-tool barrier.
  - One **trivial no-contact** request. Record the effect (no introduction or contact) and
    the semantic verdict separately; the early pilot already shows the effect boundary
    holding by failing closed while the `not_needed` verdict fails on a reused root (L-06).
  - One **unknown-send/Stop race**: Stop a supervised fixture chat while a helper check-in
    or root check-in is in flight; and cut the connection or kill the process between the
    `sending` record and the receipt for a root check-in, an introduction and a helper
    webhook POST, then restart. Expect no duplicate native message, the original identity
    reconciled, exactly one operative notice, and recorded native counts and timestamps.
  - **UI-STORY-01..08** recorded on the baseline build (below).
  This evidence is reused after S6a/S6b (rerun of the same journeys) and S7; it is not a
  full historical campaign.
- **After S2:** `docker stop` gives exit 130 with finalizers run; health ready; JSON log
  lines unchanged in shape.
- **After S3:** the ported build opens the existing state volume: catalog cursor continues,
  `login.sqlite3` stays DELETE with byte-identical schema, `-wal`/`-shm` modes 0600, health
  ready; `t3-supervisor auth forge` inside the deployment gives token-only stdout and the
  exit codes, sign-in works and existing sessions survive a restart.
- **After S4:** real T3 watch (snapshot then Ack, heartbeat over 60 s idle, reconnect after
  a T3 restart); a native read RPC and a git probe on a real checkout.
- **After S6a/S6b:** rerun of the S1 pilot journeys; an uncoached No Project Start then Stop
  during interpretation (exactly one notice).
- **After S6c:** MCPX connecting directly to `/mcp/workflows`: initialize, tools/list, a
  bounded `workflow_read`, and a `workflow_write` (first call may be pending; the identical
  retry applies once). No session header, bearer only, Host allowlist, foreign Origin
  rejected.
- **After S6d:** cut-over on the Lab `guidance.sqlite3` under concurrent MCP writes and the
  supervision cycle: no SQLITE_BUSY and no newly introduced self-contention (measured
  event-loop delay against the S1 baseline workload; the synchronous `busy_timeout`
  limitation remains), pragmas unchanged, team/monitor/receipt rows intact, definitions
  revision identical.
- **After S6e:** rerun the pilot journeys through the typed submission tool and repeat the
  model comparison of 3.12 (Luna MAX versus Sol 6.1 LOW, Luna HIGH labelled separately).
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
  wiring fixtures), `test/support/cli-bin.ts` (built/installed bin harness),
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
| D-27 | Typed interpretation submission (Andrea) | owner proposal 3.12: record-only MCP tool bound to the interpretation run, existing apply and introduction path, no model-chosen target, no fallback; slice S6e after S6d so it is built once on the final engine; pending Sol/Astra alignment |
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
- **D-26 (proposal):** W5 found no `src` caller for the GuidanceStore notice-pipeline
  methods `commit`, `start`, `finish`, `reset`, `reserveTokens`, `notices`,
  `resolveEpisode`, `saveRule` and `mute` (`classify` is used only as a test fixture and
  stays). Instead of porting dead code, S6d deletes them in a separately reviewed commit
  that carries the call-graph proof; CT-GDB-03..05 retire with them and constructor
  recovery (CC-RECOVERY) stays. If either reviewer objects, they are ported mechanically
  and the three cases stay.

## 13. Findings and acceptance ledger (v2)

One ledger for both reviewers, Andrea's directions and the owner's findings. "Resolved in
v2" means the plan and manifest now meet the stated requirement; each reviewer confirms or
reopens it on the frozen revision. Manifest rows carry the IDs that affect them in
`reviewFindings`; `reviewLedger` in the manifest repeats this table with evidence anchors.

| ID | Source | Requirement (short) | Response and evidence | Status |
| --- | --- | --- | --- | --- |
| SOL-PLAN-01 | Sol P0 | complete native-authorized mutation and real helper HTTP characterizations | CT-INT-01 (authenticated MCP `workflow_write` → production-wired write controller → production native adapter → loopback T3 HTTP/WS peer → real `guidance.sqlite3`: valid proof, weak/foreign/truncated/missing/lagged proof with zero rows, replay/conflict, Stop/generation/source change), CT-INT-02 (`supervision_team` through `authorizeNative`), CT-INT-03 (production team runtime + transport + global `fetch` over a real loopback socket: lost reply + restart, stalled/truncated 2xx, Stop/quarantine before and after the POST, redirect), all `s1-baseline` (5.4; registry) | resolved in v2 |
| SOL-PLAN-02 | Sol P0 | exact Stop publication / native initiation linearization; identified controlled-interleaving tests | 3.11 CC-STOP-LIN with the 18-path table (`contracts.CC-STOP-LIN.paths`); D-07 snapshot dropped (baseline has none); admission section; CT-LIN-01..06 with phases | resolved in v2 |
| SOL-PLAN-03 | Sol P1 | D-01 phases per row, interim bridges ledgered with owner/removal, four named DB interfaces, AccessDb lifetime, SQL wait/rollback/COMMIT/CAS tests | 3.2 (`CatalogDb`/`GuidanceDb`/`PolicyDb`/`AccessDb`, lifetimes, rules 6–7, CT-SQL-01..04), 3.4 + row `phases`, 3.9 (B-01..B-03, no Layer rebuild, no second connection), `guidance-application.ts` in S6c | resolved in v2 |
| SOL-PLAN-04 | Sol P1 | phase/seam/expected/target per case; known failures as red evidence; consolidation | 5.1 phases; registry fields for every case; CT-TCTRL-03 `known-failure` in S1b with D-21; consolidations in 5.4 | resolved in v2 |
| SOL-PLAN-05 | Sol P1 | compiled/installed bin harness, signals, probe cases, tooling in lint/typecheck | 3.1 (CT-CLI-BIN-01..03, CT-PROBE-T3-01..05, entries), 5.3 rule 4, section 9 watchdog row, section 11 lint/typecheck coverage | resolved in v2 |
| SOL-PLAN-06 | Sol P1 | mounted baseline stories, lifetimes, scope/session keys, mutation non-replay, guidance order | 3.8; section 7 UI-STORY-01..08; CT-UI-EDITOR-01, CT-UI-SETUP-01 | resolved in v2 |
| SOL-PLAN-07 | Sol P0 | uncoached operative + trivial no-contact + unknown-send/Stop pilot at the S1 gate | section 7 first bullet; S1 exit gate in section 6 | resolved in v2 (evidence is the coordinator's) |
| SOL-PLAN-08 | Sol P1 | monotonic elapsed time, wall time for stored timestamps, clock-jump test | 3.5 CC-CLOCK-ELAPSED/CC-CLOCK-WALL; CT-CLOCK-01; rows `t3.ts`, `t3-projection-stream.ts`, `workflow-write-controller.ts` | resolved in v2 |
| SOL-PLAN-09 | Sol P1 | mandatory Schema boundaries; exact API spellings; stale labels | 3.10; rows name decode boundaries; `Layer.scoped`/`Schema.parseJson` removed; stale D1–D11/S3d labels mapped; API check script 0 problems | resolved in v2 |
| A-P01 | Astra | acyclic service/API transition map; rows normalized; S1 VM proof before the campaign | 3.9 (extraction, call order, B-01..B-03); section 6 slices and v1→v2 map; every row's slice/phases normalized; S1 gate | resolved in v2 |
| A-P02 | Astra | one server-lifetime auth client; forge separate; concurrent HTTP-login test | 3.2 table and D-24; CT-AUTH-05 | resolved in v2 |
| A-P03 | Astra | shared admission rule for Stop/Enable publication and all fresh sends; masking, order, callers, barriers | 3.11 and `CC-STOP-LIN.paths` (interpretation, Start activation, thread creation, root check-in, introduction and fallbacks, Stop notices, settlement, guide and replay, helper POST, channel upsert/retire); CT-LIN-01..06 | resolved in v2 |
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
| ANDREA-CLI-01 | Andrea | CLI on Effect end to end via `effect/cli`; preserve token stdout, commands, path security, exit meaning; flag behaviour changes | 3.1; BC-CLI-01..04 for both reviewers | resolved in v2 (BC acknowledgement pending) |
| ANDREA-EXEC-01 | Andrea | use subagents in the implementation phase after the plan gate; disjoint ownership, shared contracts central, isolated worktrees, owner integration, every worker terminal before each frozen candidate | section 6.1; manifest `workPackages` and per-row `workPackage` (no file in two packages of one slice, checked by the generator) | resolved in v2 |
| ANDREA-ITOOL-01 | Andrea | typed Supervisor MCP interpretation submission validated with `Schema`, exact native identity/source/run/binding authority, no T3 change, superseded parsing removed, no fallback or duplicate store | 3.12 items 1–5, 8; CC-INTERP-SUBMIT; CT-ISUB-01..16; slice S6e; D-27 | proposed; pending Sol/Astra alignment |
| ANDREA-ROUTE-01 | Andrea | could the tool also dispatch to the right thread? | 3.12 item 6: no; record-only tool, service-owned routing to the binding's main through the existing introduction path; optional scope wake for speed | proposed; pending Sol/Astra alignment |
| ANDREA-ITOOL-EVAL-01 | Andrea | evaluate (only) whether other model-to-service structured results need typed MCP tools; add none for uniformity | 3.12 gap table: interpretation needed (approved); agreement and definition-decision records possible-needed only on post-S6e evidence; helper markers, team, guide, workflow, Start/Stop keep; monitoring unnecessary; no other tool added, nothing blocks the migration | evaluated; no further tool |
| ANDREA-MODEL-01 | Andrea | compare correctness and speed of GPT-6 Luna MAX and GPT-6.1 Sol LOW (Luna HIGH labelled separately); interpretation/validation and negotiation latency only | 3.12 model comparison; section 7 S1 and S6e bullets; D-28. Baseline so far (same root): greeting Sol LOW correct `not_needed` 3.019 s vs Luna HIGH 16.509 s with stale CSV; bare Start 7.777 s vs 9.114 s; Sol LOW coding plan 17.576 s missing the final brace (failed closed); provider JSONL confirms the missing braces are model output, not T3 truncation; Luna MAX pending | open (coordinator evidence; defaults unchanged) |
| SOL-FILES | Sol | 34 per-file rows reference SOL-PLAN-01..09 | each row carries the IDs in `reviewFindings` and its row change; validation lists 34/34 | resolved in v2 |
| ASTRA-FILES | Astra | 113 per-file rows reference A-P01..A-P08 and O-03 | each row carries the IDs in `reviewFindings`; slices, phases, Schema boundaries, clock domains and test phases normalized; validation lists 113/113 | resolved in v2 |
| L-01 | W4 | helper channel `scheduledTasks.upsert` is sent after awaits without a recheck (`supervisor-helper-transport.ts:235-244`) | preserved exactly; repair is a separate decision | open decision (not blocking) |
| L-02 | W4 | guide dispatch-failure replay does not recheck policy (`supervisor-team-controller.ts:560-577`) | preserved exactly | open decision (not blocking) |
| L-03 | W4 | active-chat settlement does not recheck Enable after its awaits (`supervisor-lifecycle.ts:346-404`) | preserved exactly | open decision (not blocking) |
| L-04 | W4 | bookkeeping failure after a policy commit (no notice; stale `chatEnabledAt`) | preserved and pinned by CT-LIN-03 | open decision (not blocking) |
| L-05 | W4 | a 307 response makes `fetch` POST the webhook body again to `Location` (unverified until CT-INT-03 H6 runs) | pinned by H6; D-16 keeps it | open decision (not blocking) |
| L-06 | Coordinator (early VM pilot) | unchanged VM, archived fixture `54c7e18a-ca52-498f-8467-f63c689656ff`, root `supervisor-root:9b20f073-bfdd-4d01-9dc9-7926d079de0d`, no new chat or project, model and settings unchanged. Genuine bare Start passed (source-pinned MCPX `supervision_start`, run 16; one reconciliation repeat of the stable operation; root run 6 `startRequested: true`, `objective: null`; UI active, `effectiveEnabled: true`, same root). Greeting ("Hi! Hope your day is going well.", `earlierMessages: []`): the reused root (run 7) resurrected an older CSV request from its own history and answered `needed`; the interpretation was **rejected** (task `18f2a960` `unavailable`, `objective: null`, `agreement: null`, "The Supervisor did not return a valid, source-linked interpretation"); no introduction or contact was authorized or observed. An uncoached coding request's interpretation also carried stale CSV context and was rejected; native operative coding continued independently | two separate results: (a) the **no-contact effect boundary passed** by failing closed and stays a preserved effect invariant (A-09); (b) the **semantic `not_needed` verdict failed / is unproven** on a reused root with prior history, a model and proof limit recorded as baseline evidence, not relabelled correct, not fixed, coached or retried in this batch; the same fixture class is rerun after S6a/S6b and compared on both (a) and (b) | (a) baseline pass; (b) recorded baseline limit (coordinator evidence) |

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
- **A-12 (after S6e, if D-27 is aligned):** interpretation results arrive only through the
  typed submission tool; no model text is `JSON.parse`d; the operative target always comes
  from the binding; a submission never counts as agreement.
