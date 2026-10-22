# Effect v4 migration plan

Status: **plan v1 (phase 1: inventory, contracts and test plan)**. No production or test
port starts until the coordinator confirms both adversarial plan reviews (Sol, Astra) and
ledger alignment. Owner: Opus (sole implementation owner). Manifest:
[`effect-v4-files.json`](effect-v4-files.json) (one row per baseline tracked file).

## 1. Baseline

| Item | Value |
| --- | --- |
| Commit | `3b8129aea24518774b7237d666c22739e82af3b6` (`main` == `origin/main`) |
| Branch / worktree | `effect-v4-migration` at `/var/lib/t3/worktrees/t3-supervisor/effect-v4-migration` |
| Tracked files | 159: 55 `src`, 1 `scripts`, 48 `test` (47 suites + 1 fixture), 23 `ui`, 10 `docs`, 4 `skills`, 2 `.impeccable`, 1 CI workflow, 15 root config/docs |
| Tests | node:test via `tsx --test`: **869 reported, 869 pass, 0 fail/skip/todo** (local, Node 24.22.1, 196 s). JUnit map: 849 top-level tests = 843 top-level leaves + 6 parent tests; the 6 parents contain 20 subtests and make no direct assertions (`service-auth` 4+4+4, `supervisor-conversation` 2+3 from loops, `supervisor-helper-transport` 3 from a loop); 843 + 20 = 863 leaf cases; 863 + 6 = 869 Node results. Coordinator-reported CI: run 39804448963 attempt 2 (not re-run here). |
| Effect today | `effect`/`@effect/platform-node`/`@effect/atom-react` 4.0.1. Effect is used at the edges only: `NodeRuntime.runMain` in `src/main.ts`, `Store` and `T3Client` services, the HttpApi contract and server in `guidance-contract.ts`/`guidance-ui.ts`, Schema decoding, and `AtomHttpApi` for two UI atoms. Business modules are Promise/class based, with 23 `Effect.runPromise` calls inside `project-supervisor.ts` (12), `project-definitions.ts` (8), `guidance-application.ts` (2) and `guidance.ts` (1), synchronous `node:sqlite` stores, `ws` callbacks and timers. |

The manifest records each file's leaf test names in file order under `testNames` (subtests as
`parent > child`) and the parity arithmetic plus the 6 named groups under `baseline.tests`.

## 2. Effect version decision and provenance

**Target: `effect` 4.0.5 and every Effect companion at exactly 4.0.5 (exact pins, no caret).**
Verified on 2026-10-22 (UTC) against the npm registry, GitHub releases and the installed
4.0.5 source. The coordinator registry check on the same day agrees (`latest` = 4.0.5).

| Package | Version | npm publish (UTC) | GitHub release (UTC) | npm integrity (sha512, prefix) | Use |
| --- | --- | --- | --- | --- | --- |
| `effect` | 4.0.5 | 2026-10-15 01:27:07 | `effect@4.0.5` 01:03:10 (tag commit `7f524e25`) | `BY4/28NlpOd99yzm…` | core, http, http-api, sql, cli, reactivity, socket, testing |
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
`effect/socket`, `effect/process`, `FileSystem`, `Path`, `Crypto`, `Terminal`, `Stdio`,
`effect/testing` except `TestClock` (stable), and every non-`effect`
package. Policy: exact pins for all Effect packages and `vitest`; upgrades are separate
ledger items with their own parity run; no API from an `experimental` module.

## 3. Target architecture

The port keeps every observable behaviour and on-disk format. What changes is the structure:
one Layer graph owns every resource, controllers are Effect services, all time goes through
`Clock`, all I/O goes through platform, socket, HTTP or SQL services, and tests use injected
Layers. Pure calculations, types and JSX stay plain.

### 3.1 Process, CLI and configuration (CC-CLI, CC-CONFIG, CC-SHUTDOWN, CC-HEALTH)

- `src/cli.ts` runs an Effect program under `NodeRuntime.runMain` with
  `disableErrorReporting: true` and exit codes taken from `Runtime.errorExitCode` on tagged
  errors (no `process.exitCode`). `start` launches the server Layer; `auth forge` runs the
  forge effect without loading full configuration. The exact contract is pinned first by
  CT-CLI-01..05: `--help`/`-h` -> usage on stdout, exit 0; any other shape (relative path,
  `--data-dir=x`, extra arguments) -> usage on stderr, empty stdout, exit 2; forge -> token
  only on stdout, empty stderr; forge failure -> fixed stderr message, exit 1; no token in
  logs. `effect/cli` prints help to stdout on parse errors and exits 1
  (`cli/Command.ts:2751-2764`, `cli/CliError.ts:656`), so its use is decision D-02.
- One `SupervisorConfig` service built from `Config` (`Config.String`, `Config.withDefault`,
  `Config.option`, `Config.schema`) over `ConfigProvider.fromEnv`, keeping today's names,
  defaults and validation. `fromEnv` drops empty strings by default and `Config.Port`/`Int`
  are stricter than `Number()`, so parsing keeps the baseline semantics exactly
  (D-06). Token files are read through `FileSystem` into `Redacted` values and are never
  printed or logged. The fields that `main.ts` mutates today become services
  (`ThreadPolicy`, `SupervisorOwnership`) in the same commit as all their readers; until
  S6c the `ThreadPolicy` service keeps the existing synchronous store API (D-01).
- Logging is a JSON `Logger` keeping the one-line `{"time","event",...}` shape.
  `Headers.CurrentRedactedNames` gains `x-supervisor-session` and `x-csrf-token`; the
  HTTP logger stays disabled (CC-REDACT).
- Health is an `HttpRouter` on `NodeHttpServer` with the same port, paths, bodies and
  status codes; readiness reads a status `Ref` instead of a shared mutable object.
- Shutdown: `runMain` interrupts on SIGINT/SIGTERM (exit 130 interrupt-only). The Layer
  graph releases supervision and listeners before stores, which reverses today's window
  in which the catalog store closes first (D-10, pinned by CT-MAIN-02).

### 3.2 Persistence (CC-GDB, CC-DBFILES, CC-FILEMODES, CC-AUTH, CC-CATALOG)

One `SqliteClient` per database file, built once at the root of the Layer graph and provided
to every store on that file. In 4.0.5 the transaction connection is a per-client context key
(`effect/src/sql/SqlClient.ts:179`), `withTransaction` propagates it through the fiber context
with SAVEPOINTs for nesting and rolls back on failure or interruption (`makeWithTransaction`,
`uninterruptibleMask`), and statements/transactions share one connection under `Semaphore(1)`
(`makeSqliteAcquirers`, `SqlClient.ts:304-375`; `@effect/sql-sqlite-node/src/SqliteClient.ts:345`).
Plain statements borrow the permit per statement, so sequences outside a transaction can
interleave. Rules:

1. Exactly one client per file. No store opens its own connection, so receipts, native
   proof, workflow edits, acknowledgements and Stop state that commit together today still
   commit in one transaction (Astra F-001).
2. Cross-service calls inside a transaction are plain Effect calls in the same fiber and
   inherit the transaction connection. `db.isTransaction` joins become nested
   `withTransaction` (SAVEPOINT); no inner failure is caught inside an outer transaction
   today (CC-NESTTX).
3. No native T3 call, HTTP call, filesystem write, sleep, `forkChild` or nested `run*`
   inside a transaction (holding the only connection would deadlock other fibers).
   Intent records (dispatch markers, `sending`/`committed` states, IDs) are committed
   before any native send (CC-RECEIPT-FIRST).
4. Interruption inside a transaction rolls it back. This failure mode does not exist in the
   baseline and gets dedicated tests.
5. `busy_timeout` waits still block the event loop (`node:sqlite` is synchronous).

| File | Owner | Journal | Guarantees | Client | Slice |
| --- | --- | --- | --- | --- | --- |
| `catalog.sqlite3` | `store.ts` | WAL | `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=256`, `secure_delete=ON`, `max_page_count`; dir 0700, db/-wal/-shm 0600 | `SqliteClient.layer`, file created and chmodded 0600 before open, pragmas after open | S3 |
| `access/login.sqlite3` | `service-auth.ts` (server and `auth forge`) | **DELETE** (validated) | `synchronous=FULL`, `busy_timeout=5000`, `max_page_count`; exactly two STRICT tables; caps/TTL; `quick_check`; O_NOFOLLOW + dev/ino identity before and after open; size bounds; opened per operation; CLI never bootstraps | `SqliteClient.make({disableWAL: true})` in a per-operation scope, after the private-files checks | S3 |
| `guidance.sqlite3` | `guidance-store.ts`; shared by project-supervisor, workflow-state, conversation, monitor, team stores, helper transport, write controller, git probe | WAL | `synchronous=FULL`, `busy_timeout=5000`, `secure_delete=ON`, `max_page_count=16384`; idempotent DDL at open; restart recovery (CC-RECOVERY) | one `SqliteClient` for every store; ownership preload from the same layer | S6c |
| `thread-settings.sqlite3` | `thread-policy.ts` | WAL | `synchronous=FULL`, `busy_timeout=5000`; single-row document; stop list read by every send path | `SqliteClient.layer` plus an in-memory snapshot updated after commit (D-07) | S6c |

`SqliteClient.make` switches to WAL inside `make`, before any caller chmod, so files are
created and chmodded 0600 first (CC-FILEMODES, W1). Extension loading is disabled right
after open; a lint rule bans `loadExtension`. No `SqliteMigrator` (D-04): it would add a
migrations table to existing user databases and break the login DB's two-table
validation; the existing idempotent at-open DDL stays.

### 3.3 Atomicity of synchronous sections (CC-SYNC-ATOMIC, CC-GDB-IMPLICIT)

Baseline code gets atomicity from run-to-completion JavaScript: 16 modules issue SQL on
shared connections and 43 `transaction(` sites in 12 modules open explicit transactions,
most of them in controllers spanning several stores. Many more read-modify-write sequences
have no transaction at all (listed in CC-GDB-IMPLICIT). In Effect, other fibers can run at
any `yield*`, and the runtime can yield inside long synchronous chains. Rules:

1. Each baseline synchronous block with more than one statement becomes one
   `withTransaction` (or is shown to be a single statement).
2. Each synchronous read-check-update of in-memory state becomes one `Ref.modify`,
   `SynchronizedRef.modifyEffect` or a section under the scope's `Semaphore`.
3. Every place where the baseline awaits between a check and a write keeps exactly that
   window; widening or narrowing it is a ledger item.
4. S1 tests force interleavings at these points against the baseline first.

### 3.4 Sequencing of the shared guidance database (D-01)

`guidance.sqlite3` cannot move to `SqlClient` store by store: a second connection to the
same file deadlocks or returns SQLITE_BUSY while the Effect client holds a transaction
across yields (W1, W2 and W3 found this independently). Porting the stores first is not
possible either: the Promise-based controllers open synchronous transactions that span
several store calls, and an Effect store call cannot run inside a synchronous
`transaction(() => ...)` body. The interim proposed by W2/W3 (Effect-typed store methods implemented with
`Effect.sync`) is unsafe on its own: a fiber can yield between two `yield*`s inside an
open `BEGIN IMMEDIATE`, and another fiber's statement then joins that transaction through
the existing `isTransaction` checks. Plan:

1. S4, S5, S6a and S6b port controllers and transports to Effect services. They keep
   calling the existing synchronous store API, but only inside explicit `Effect.sync`
   critical sections, one per baseline synchronous block. Each thunk runs to completion,
   so atomicity is exactly the baseline's and is visible in code.
2. S6c switches the whole file, together with `thread-settings.sqlite3`, in one commit
   series: one `SqliteClient`, every store method becomes an Effect, every critical
   section becomes `withTransaction`, and the CC-GDB-IMPLICIT sequences are wrapped. The
   synchronous API is deleted in the same slice; nothing permanent remains.

### 3.5 Controllers, time and identities (CC-CLOCK, CC-IDS, CC-SCOPE-SERIAL)

Each controller becomes a `Context.Service` with a Layer. State machines that are durable
rows stay rows; transitions run in transactions. In-memory state uses `Ref`/
`SynchronizedRef`; per-scope serialization uses `RcMap<scopeKey, Semaphore>` (the Scanner
`namespacedLock` pattern, section 8); in-flight jobs use `FiberMap`; timeouts use
`Effect.timeout` instead of `AbortSignal.timeout`; cross-cycle retries stay persisted data
compared with `Clock`, not `Schedule`. The supervision loop is
`Effect.repeat(Schedule.spaced("5 seconds"))` after each cycle with
`Effect.timeout("120 seconds")` per cycle. IDs come from one `SupervisorIds` service
(`Crypto.randomUUIDv4` with a `NodeCrypto` layer, `TestCrypto` in tests) with unchanged
persisted formats. Business code never calls `Effect.run*`. The `ProjectSupervisor`
constructor cycle (callbacks into itself, `teamEffects` attached later in
`guidance-application.ts:100`) is broken by a `SupervisionScope` service in the first
S6a commit (W3).

### 3.6 Native transports (CC-T3RPC, CC-WSFRAME, CC-NATIVE, CC-FILES, CC-PROBE)

The native frames (`Request`/`Ack`/`Ping`/`Pong`/`Chunk`/`Exit`) are the `effect/rpc`
`RpcMessage` protocol (`effect/src/rpc/RpcMessage.ts:72-442`, `src/t3.ts:685-721`), but they
are implemented by hand six times. S4 replaces them with one shared implementation (D-08):
`RpcClient` over `Socket` if a spike against recorded real frames proves exact behaviour,
otherwise one Effect envelope adapter over `Socket.makeWebSocket`. Either way:

- per-call `maxPayload` (32/8/2/2 MiB) and binary-frame rejection are kept;
- a custom `Socket.WebSocketConstructor` keeps a permanent `error` listener (otherwise a
  handshake timeout can surface an unhandled `ws` error, W1 D4) and terminates on release
  like today;
- the "sent" boundary that separates `rejected` from `uncertain` (CC-NATIVE) stays
  observable;
- an unknown outcome is never retried under a new ID.

### 3.7 HTTP API, auth and MCP (CC-HTTPAPI, CC-WEBSEC, CC-AUTH, CC-MCP)

`SupervisorApi` already declares every `/api/guidance/*` endpoint
(`src/guidance-contract.ts:96-160`); handlers become Effect services without `tryPromise`
wrappers. Host/Origin/CSRF/session checks stay router-level `HttpRouter` middleware so the
exact check order, `{"message"}` bodies, statuses and headers are kept (D-12); `/auth/*`,
`/api/csrf` and static files move onto the same router. `/mcp/workflows` stays stateless
Streamable HTTP with direct bearer authentication and no proxy. Effect's own `McpServer` is
sessionful for every protocol version up to 2025-11-25 (`ai/McpProtocol.ts:211-254`,
`ai/McpServer.ts:915-931`), so the SDK transport stays as a scoped adapter inside an Effect
route that owns auth, the 9 s timeout, abort and close (D-03).

### 3.8 UI (CC-UI-SESSION, CC-UI-DRAFTS, CC-START-FENCE, CC-BINDING-GEN)

`AtomHttpApi.Service` covers every endpoint. Queries are atom families keyed by exact
scope; mutations are AtomHttpApi mutations or `Atom.fn` with the existing outcome mapping
(401/403/413/415 = definitely not saved, others = unconfirmed). Polling uses
visibility-aware refresh signals. Drafts live in keep-alive writable atom families. The
Start fence persists through `KeyValueStore` (sessionStorage) or a small storage adapter.
Browser-only APIs (storage events, history, beforeunload) stay small scoped adapters.
Markup, classes, strings and CSS do not change. 4.0.5 lacks two atom fixes from 4.0.6
(#9607 lost previous success, #9313 registry layer replacement), so S7 tests pin
"last successful read is kept" explicitly and provide test layers through the runtime
factory. UI work starts with Impeccable, then modern-web-guidance and wcag-accessibility.
These skills are **not installed in this remote session**, so S7 waits for them (local
coordinator or installation) and uses `PRODUCT.md`, `DESIGN.md` and `.impeccable/*` as the
design authority.

### 3.9 Interim boundaries between ported and unported modules

Slices go mostly bottom-up (transports and services before their callers), so for a while
some unported Promise code calls ported Effect services. Rules:

1. Ported code never contains a bridge: no `Effect.run*`, no `Effect.tryPromise` around an
   old implementation, no Promise state machines.
2. While a caller is unported, its existing call sites may run a ported service with
   `Effect.runPromise(effect, {signal})`, the same pattern the baseline already uses 23
   times. Each new bridge is listed in the ledger with the slice that removes it (the
   caller's slice). The caller is rewritten in that slice, not patched.
3. The only top-down exception is D-01: ported controllers call the synchronous
   `guidance.sqlite3`/`thread-settings.sqlite3` store API inside `Effect.sync` critical
   sections until S6c.
4. S8 lint bans `Effect.run*` outside the entry points (`src/main.ts`, `src/cli.ts`,
   `ui/src/main.tsx`) and test harness files; the bridge list must be empty before S8.

### 3.10 Errors

Local diagnostic errors use `Data.TaggedError`. Errors that cross a wire, persisted state or
an HTTP/MCP boundary use `Schema.TaggedError` with a stable shape and an inner `reason`
union where callers decide on the variant. Raw causes stay in logs/spans, never in HTTP
bodies, and HTTP bodies keep their exact JSON. `SupervisorRpcError` keeps its four flags
(`outcome`, `definiteRejection`, `providerDisabled`, `dispatchCommandFailure`).

## 4. Cross-file contract map

Full invariants, participants (derived from manifest rows) and pins are in
`effect-v4-files.json` under `contracts`.

| ID | Owner | Slice | Invariant (first clause; full text in the manifest) | Pins |
| --- | --- | --- | --- | --- |
| CC-AUTH | `src/service-auth.ts` | S3 | login.sqlite3 journal_mode DELETE, exactly two STRICT tables, caps of 32 grants/sessions, grant consume + session insert in one BEGIN IMMEDIATE, O_NOFOLLOW + dev/ino identity checks, fchmod 0600/0700, link()-based atomic create, dir fsync | service-auth.test.ts, auth-cli.test.ts, CT-AUTH-01..04 |
| CC-BINDING-GEN | `src/project-supervisor-contract.ts` | S7 | UI and API results are applied only to the exact project/main/binding generation that requested them. | CT-UI-PS-02, project-supervisor-ui tests |
| CC-BINDING-MERGE | `src/project-supervisor-store.ts` | S6c | stale full-document binding writes keep the stored stopNotice/supervisionStop | CT-LIFE-02 |
| CC-CATALOG | `src/store.ts` | S3 | Store service shape unchanged | store.test.ts, t3 watch tests, CT-STORE-01..03 |
| CC-CLI | `src/cli.ts` | S2 | --help\|-h alone -> usage on stdout, exit 0 | auth-cli.test.ts, CT-CLI-01..05 |
| CC-CLOCK | `cross-cutting (plan section 3.5)` | S2 | every Date.now/performance.now/timer moves to Clock/Schedule/TestClock with identical durations (60 s cooldowns, 5 s throttles, 20/30 s native deadlines, 120 s cycle timeout, 5 s after-cycle spacing, 5000 ms test deadlines). | per-slice TestClock tests |
| CC-CONFIG | `src/types.ts` | S2 | same env names, defaults and validation (invalid_helper_provider_instance_id) | config.test.ts, CT-CONFIG-01..03 |
| CC-CONTROL | `src/project-supervisor-store.ts` | S6b | every control has its own generation CAS (master, project, No Project, global definitions) | No Project defaults to On request and shared definitions never activate a chat, supervisor-control.test.ts |
| CC-DBFILES | `cross-cutting (plan section 3.2)` | S3 | per-file journal mode and pragmas exactly as today (catalog/guidance/thread-settings WAL + listed pragmas | CT-FILES-MODE-01, CT-AUTH-01..04, per-DB pragma tests |
| CC-DEFS | `src/project-definitions.ts` | S6b | definitions revision = sha256 of [projectId, threadId, root, scratch, inputs], set only when complete | CT-PD-03 |
| CC-FILEMODES | `src/store.ts` | S3 | data dir 0700, database files 0600 including -wal/-shm (catalog chmods on open/commit/close | CT-FILES-MODE-01 |
| CC-FILES | `src/project-files.ts` | S4 | writer failures after send -> unavailable mapped to uncertain by the editor, never retried | project-committer.test.ts, project-config-editor.test.ts, CT-FILES-01..03 |
| CC-GDB | `src/guidance-store.ts` | S6c | guidance.sqlite3 is served by exactly one connection | CT-GDB-01..06, CT-PSS-08, CT-WSS-01 |
| CC-GDB-IMPLICIT | `src/guidance-store.ts` | S6c | multi-statement read-modify-write sequences without a transaction are atomic today only because synchronous JS runs to completion (guidance-store observe/reserveTokens/prune/resolveEpisode, conversation-store prepare/saveAgreement*, team-store pre-checks, project-supervisor-store saveTask/saveStart/observeModel/chatStop/activation, git-probe add/removePending, helper-transport authority check -> receipt) | CT-CSTORE-02, CT-TSTORE-01, CT-TSTORE-02 |
| CC-HEALTH | `src/supervisor.ts` | S2 | 0.0.0.0:HEALTH_PORT, exact /health and /live paths (query string -> 404 empty), body {ok, readiness, ...status}, 200/503, any method | CT-HEALTH-01 |
| CC-HELPER-RECEIPT | `src/supervisor-helper-transport.ts` | S6a | exact sent bytes and write-once rendering/message id/contradiction in supervisor_helper_deliveries | helper-transport tests, CT-HTX-01..04 |
| CC-HTTPAPI | `src/guidance-contract.ts` | S5 | SupervisorApi endpoints, payload/response Schemas and error encodings stay wire-identical for server (guidance-ui.ts) and client (ui/src/api.ts AtomHttpApi). | CT-UI-01..08, CT-UI-API-01 |
| CC-IDS | `src/supervisor-conversation-store.ts` | S6a | persisted identity formats (supervisor-review:<id>, supervisor-notice:workflow:<taskId>, supervisor-objective:<taskId>, supervisor-create:<thread>:<generation>, supervisor-settle:<uuid>, team-ready/team-review/guide/supervisor-helper ids, UUIDv4) never change | CT-SW-01, golden id tests per store |
| CC-INTERP | `src/project-supervisor.ts` | S6b | interpretation command persisted 'dispatching' before RPC | project-supervisor.test.ts L770-L964, CT-PS-01, CT-PS-02 |
| CC-MCP | `src/workflow-mcp.ts` | S5 | stateless Streamable HTTP at /mcp/workflows (no Mcp-Session-Id), JSON responses, 1 MiB body, 9 s per call, abort on client close, tool list order, isError reasons | workflow-mcp.test.ts, CT-MCP-01..05, CT-WWC-06 |
| CC-MONITOR-ACK | `src/supervisor-monitor-store.ts` | S6a | frozen activity batches are acknowledged only at their exact version inside the caller's transaction. | monitor L637/L657/L1012, conversation L1799, team-runtime L739/L974 |
| CC-NATIVE | `src/supervisor-native.ts` | S4 | outcome classification: before send -> rejected (not definite) | supervisor-native.test.ts 1-8, CT-NATIVE-01..04 |
| CC-NESTTX | `src/supervisor-team-store.ts` | S6c | join-if-in-transaction else open (db.isTransaction) and caller-owned *InTransaction APIs become nested withTransaction (SAVEPOINT/RELEASE) | CT-TSTORE-03, CT-TCTRL-03 |
| CC-NOPROJECT-DEFAULT | `src/project-supervisor-store.ts` | S6b | On request remains the No Project default in store, API and UI presentation | no-project-ui.test.ts, project-supervisor.test.ts L1568 |
| CC-OVERVIEW-RANGE | `src/dashboard-overview.ts` | S7 | readOverviewRange pages by 100 and keeps the previous read on failure. | dashboard-overview.test.ts, CT-UI-OVERVIEW-01 |
| CC-OWNED | `src/supervisor-team-store.ts` | S6c | registerMember must not add an owned id before the outermost commit (latent phantom id on rollback today) | CT-TCTRL-03 |
| CC-OWNERSHIP | `src/project-supervisor-store.ts` | S6c | owned Supervisor thread ids are loaded before catalog filtering | supervisor-ownership.test.ts, CT-PSS-05 |
| CC-PROBE | `src/git-probe.ts` | S4 | pending {threadId, terminalId} persisted before terminal.open, removed only after successful terminal.close | git-probe.test.ts, CT-PROBE-01..03 |
| CC-PROOF | `src/workflow-write-evidence.ts` | S6b | native authority: exact own-main-run dynamic_tool item with canonically equal arguments | workflow-write-controller.test.ts L372-L683, CT-WWE-01 |
| CC-RECEIPT-FIRST | `src/supervisor-conversation.ts` | S6a | a durable sending/posting/uncertain/prepared record with the final native identity is committed before the native effect | CT-CONV-01..03, CT-TRUN-01, CT-HTX-01 |
| CC-RECOVERY | `src/guidance-store.ts` | S6c | on open: notices committed -> not_delivered_restart (dispatch_started=0) or uncertain (=1) with one process_recovery activity each | CT-GDB-01, team-store L290 |
| CC-REDACT | `src/credential-redaction.ts` | S2 | no credential, token or native error body in logs, errors or HTTP bodies | t3.test.ts 4/14, team-controller L186, CT-CLI-05 |
| CC-SCOPE-SERIAL | `src/project-supervisor.ts` | S6b | run/reconcile/check of one Supervisor scope never overlap (serial(scopeKey)) | CT-PS-03, CT-PS-05 |
| CC-SETUP-FENCE | `ui/src/supervisor-control.tsx` | S7 | supervision setup fence latches on uncertainty and blocks other control changes until a verified read. | supervision-controls-ui.test.ts |
| CC-SHUTDOWN | `src/main.ts` | S2 | SIGINT/SIGTERM interrupt the main fiber | CT-MAIN-01..03 |
| CC-START | `src/project-supervisor.ts` | S6b | one receipt per (thread, operationId) with requestHash | project-supervisor.test.ts L1568-L1786, CT-PS-04, CT-PS-06 |
| CC-START-FENCE | `ui/src/no-project.tsx` | S7 | a retained browser Start intent (threadId, operationId) blocks new Starts until a terminal status | CT-UI-START-01 |
| CC-STATUS | `src/supervisor.ts` | S2 | status written by 4 fibers | supervisor.test.ts, CT-HEALTH-01 |
| CC-STOP | `src/project-supervisor.ts` | S6b | a per-chat human Stop fences every new send | CT-PS-07, CT-PS-09, CT-PSS-03 |
| CC-SYNC-ATOMIC | `cross-cutting (plan section 3.3)` | S6a | every baseline synchronous block (DB or in-memory read-check-write) maps to one Effect.sync section, Ref.modify, SynchronizedRef or Semaphore-guarded section | S1 race tests per controller |
| CC-T3RPC | `src/t3.ts` | S4 | native T3 RPC frames are the effect/rpc RpcMessage protocol (Request/Ack/Ping/Pong/Chunk/Exit) | t3.test.ts, CT-T3-01..05, CT-WSFRAME-01 |
| CC-TEAM-EPOCH | `src/supervisor-team-store.ts` | S6a | member epoch + assignment epoch + coverage CAS on every helper write, request, assessment, notice and guide | supervisor-team-store.test.ts, team-controller L218, team-runtime L1589/L1681/L1700 |
| CC-UI-DRAFTS | `ui/src/main.tsx` | S7 | drafts survive reloads, session expiry and re-sign-in | CT-UI-SHELL-01, CT-UI-PS-01 |
| CC-UI-SESSION | `ui/src/access.ts` | S7 | session token only in localStorage | browser-access.test.ts, CT-UI-AUTH-01 |
| CC-WEBSEC | `src/guidance-ui.ts` | S5 | exact Host/Origin/CSRF/session check order, JSON {message} bodies, security headers | guidance.test.ts, project-config-editor.test.ts #5, CT-UI-01..08 |
| CC-WFCAS | `src/workflow-state-store.ts` | S6c | UPDATE ... AND revision=? with changes===1 and the receipt in the same transaction | workflow-state.test.ts L269, CT-WSS-01, CT-WSS-02 |
| CC-WFPLAN | `src/supervisor-workflow.ts` | S6b | canonicalJson, fingerprint (sha256 of JSON.stringify), seeded node ids, compactProposalDigest and stateHash are persisted identities and stay byte-identical. | CT-SW-01, CT-SWA-01, CT-WSS-04 |
| CC-WFRECEIPT | `src/workflow-write-controller.ts` | S6b | workflow write receipts keyed by owner, generation, namespace, operationId, requestHash | workflow-write-controller.test.ts L343-L1769, CT-WWC-02, CT-WWC-05 |
| CC-WSFRAME | `src/t3.ts` | S4 | one shared envelope implementation replaces the 6 hand-written copies (t3.ts, supervisor-native.ts, git-probe.ts, project-files.ts x3) without changing frames, limits, close or error handling (decisions D-08/D-09). | CT-WSFRAME-01 |

## 5. Test plan

### 5.1 Harness conversion (S0) and parity proof

- Runner: `vitest` 5.0.5 with `@effect/vitest` 4.0.5, root `vitest.config.ts`
  (`include: ["test/**/*.test.ts"]`, node environment, `pool: "forks"`, file isolation like
  `tsx --test`). `tsx` stays a dev dependency because `auth-cli` and `service-auth` spawn
  child processes and worker threads with `--import tsx`.
- S0 is mechanical: `test(...)` -> `it(...)`; each of the 6 `t.test` groups -> a `describe`
  with the same name whose 20 cases keep their setup, cleanup and assertions
  (loop-generated cases stay loop-generated); `t.after` -> `onTestFinished`;
  `t.mock.method(Date, "now")` -> `vi.spyOn` until the owning slice moves time to
  `TestClock`. `node:assert/strict` stays until the owning slice converts the suite to
  `@effect/vitest`. No assertion, deadline, fixture or ordering change and no
  `.skip`/`.todo`/`.only`/`.fails`.
- Parity gate: compare the baseline map (`baseline.tests` in the manifest: 843 top-level
  leaves + 6 named groups holding 20 subtests = 863 leaf cases, 869 Node results) with
  Vitest's JSON reporter by file and full name. S0 must show 863/863 identical leaf names
  and 6/6 group names, all passing. Renames in later slices are ledger entries.
- Real boundaries stay real: temp-file SQLite, real `ws`/HTTP fake T3 servers, real child
  processes for the CLI and worker-thread contention tests. A mock never replaces an
  existing integration test.
- Token hygiene: tests that forge or read tokens capture child output and assert the token
  appears only on `auth forge` stdout. Failure messages print lengths or hashes, not tokens.

### 5.2 Runner policy (D-05)

Evidence: Sol's probe `/tmp/sol-effect-v4-phase1/harness-probe` and the owner's independent
reproduction `/tmp/effv4-probe` (`cases.sh`), both on exactly Vitest 5.0.5 +
`@effect/vitest` 4.0.5:

| Case | Exit | Result |
| --- | --- | --- |
| deliberate `setInterval` leak, `detectAsyncLeaks` only | 0 | leak reported, run passes |
| same leak + leak-gate reporter | 1 | `leak-gate: 1 async leak(s)` |
| clean test + leak gate | 0 | no leak |
| `it.effect` + `Effect.never` + `{timeout: 100}` | 1 | interrupted, finalizer ran |
| `it.live` + in-effect `Effect.timeout("50 millis")` | pass | typed failure, finalizer ran |
| unbounded Promise deadlock, `testTimeout: 0` | 124 | outer watchdog killed the process group at 4 s |

Vitest 5.0.5 treats `detectAsyncLeaks` as reporting only: leaks go to `state.leakSet`
(`vitest/dist/chunks/cli-api.De07GUeT.js:10832-10871`) and never set a failing exit code.
`timeout <= 0` disables per-test timeouts (`withTimeout`, `vitest/dist/chunks/run.BPv-BBRv.js:3270-3271`).
Policy:

1. **S0 parity only:** `testTimeout: 0` and `hookTimeout: 0`. node:test has no default
   per-test timeout; the Vitest default (5 s) would fail 5 passing baseline tests (5.7-30 s;
   45 tests take over 2 s). Every existing explicit deadline stays exactly as written
   (for example `AbortSignal.timeout(5000)` in git-probe, projection-stream and
   config-editor tests).
2. **Leak gate:** `detectAsyncLeaks: true` plus a `test/support/leak-gate.ts` reporter that
   fails the run on any leak. It reads `vitest.state.leakSet`, an internal field, which is
   acceptable only because Vitest is pinned exactly; the gate fails closed if the field is
   missing. S0 measures baseline leaks. Each pre-existing leak is recorded per file in the
   ledger as a counted allowlist entry and removed by the slice that owns the file; S8
   requires an empty allowlist.
3. **Outer watchdog:** `npm test` runs `scripts/run-tests.mjs`, which starts `vitest run` in
   its own process group under a 20-minute whole-run deadline (about 6x the 196 s
   baseline) and kills the group with exit 124 on expiry. CI adds `timeout-minutes: 30`.
4. **Self-tests:** `npm run test:harness` (separate config, excluded from parity, run in
   CI) proves on every change that a deliberate leak fails the gate, a deliberate
   deadlock ends with 124, and an Effect per-test timeout interrupts and runs finalizers.
5. **Ported tests (S1 onward):** `it.effect` (TestClock) for policy timing; `it.live` for
   real sockets, processes, HTTP and SQLite with explicit in-effect deadlines
   (`Effect.timeout`) and asserted finalizers. A per-test Vitest `timeout` is added only
   with evidence that it is the right guard. Existing deadlines are never raised. TestClock
   never stands in for socket, process, browser or native wire delivery.

### 5.3 Characterization before each port

The manifest lists 157 characterization tests (`characterizationTests`, kinds: 51
characterization, 25 atomicity-restart, 24 race, 20 interruption, 12 ui-draft-auth,
7 unknown-send, 6 resource, 5 cli, 4 native-authority, 3 no-contact). Each slice starts
with a commit that adds only tests against unchanged code and shows they pass there.
**S1** is the first, cross-cutting wave, written before any port:

1. Atomic receipt/write/proof commit and rollback on the real `guidance.sqlite3` stores and
   controllers under concurrent Stop, CAS generation change and interruption (Astra
   F-001): CT-GDB-01..06, CT-PSS-08, CT-WSS-01, CT-WWC-04, CT-CONV-04, CT-CSTORE-01,
   CT-TSTORE-03, CT-MSTORE-01, CT-TCTRL-03, CT-RESET-01.
2. Unknown-send reconciliation (never resent under a new ID after restart, retry, Stop or
   interruption): CT-CONV-01..03, CT-TRUN-01, CT-HTX-01, CT-LIFE-01, CT-TCTRL-01,
   CT-PS-01, CT-PS-02, CT-PS-06, CT-NATIVE-01..04, CT-WWC-01, CT-WWC-05.
3. Native authority / own-run proof: CT-WWE-01, CT-WWC-08, CT-PSS-01.
4. Restart recovery and Stop windows: CT-GDB-01, CT-PS-07, CT-PS-09, CT-PSS-04, CT-PSS-07,
   CT-TRUN-03.
5. Login DB and CLI (Sol F-002): CT-AUTH-01..04, CT-CLI-01..05, CT-FILES-MODE-01.

The remaining tests run at the start of their owning slice. By owning file the 157 split
into S0 2, S2 16, S3 8, S4 17, S5 19, S6a 27, S6b 31, S6c 31 and S7 6.

## 6. Slices, order and gates

Each slice is a vertical cut with one owner (Opus). A slice that changes a store or
transport moves all of its callers in the same commit series, so no compatibility layer,
dual path or duplicate store exists at any freeze. Every slice has four frozen commits:
(a) characterization tests on unchanged code, (b) conversion of the touched suites to
`@effect/vitest`, (c) the port, (d) removal of superseded code plus new lint guards.
(a) must pass on unchanged code before (c) starts. Per development cycle:
`npm run autofix`, `npm run lint`, `npm run typecheck` and the touched suites. At each
freeze: the full suite through the watchdog runner, `npm run test:harness`, `npm run build`,
and a Docker build when dependencies change (S0, S3, S6c, S7) and at S8. The same two
reviewers review every freeze with the exact revision, delta, evidence and open objections.

| Slice | Content | Exit gate |
| --- | --- | --- |
| S0 | Exact 4.0.5 pins; `vitest` 5.0.5 + `@effect/vitest` 4.0.5; `vitest.config.ts`, watchdog runner, leak gate and harness self-tests; mechanical conversion of 47 suites + fixture; CI `timeout-minutes` and `test:harness`; eslint bans `node:test`; concise AGENTS.md rule (section 10) | 863/863 leaf names and 6/6 groups identical and passing; harness self-tests pass; lint, typecheck, build, Docker build; CI green on the branch |
| S1 | Cross-cutting characterization wave (5.3) on unchanged code; coordinator's early VM proof (section 7) | all S1 tests pass on baseline code; VM evidence recorded |
| S2 | `SupervisorConfig`, `Redacted` token files, JSON `Logger`, typed errors, `SupervisorIds`, CLI on `runMain` (D-02), health on `HttpRouter`, root Layer graph, status `Ref`, `ThreadPolicy`/`SupervisorOwnership` services replacing mutable config fields | CLI/config/health/shutdown tests; no `process.exitCode`, `process.env` or `process.on` outside the config/CLI entry |
| S3 | `catalog.sqlite3` (`store.ts`) and `login.sqlite3` (`service-auth.ts` + forge + HTTP auth use) on `SqliteClient` | per-DB pragma/schema/mode tests; login DELETE-journal and identity tests; Docker build |
| S4 | Shared native envelope (D-08), `t3.ts`, projection stream, `supervisor-native.ts`, `project-files.ts`, `git-probe.ts` (git-probe's guidance meta writes stay inside `Effect.sync` sections until S6c) | real-ws tests for frames, limits, close/interrupt, unknown outcomes; VM native read probe |
| S5 | HTTP API handlers, router middleware, static assets, auth routes, MCP route (D-03), guidance application wiring (replacing the `tryPromise(runOnce)` loop) | status/body matrix, CSRF/Host/Origin/session tests, MCP auth/protocol tests; no proxy |
| S6a | `SupervisionScope` service; helper transport, team runtime, lifecycle, team controller, conversation, team view as services; synchronous store calls only inside `Effect.sync` critical sections | race/interruption/restart/Stop tests; no `runPromise`, timers or promise chains left in these modules |
| S6b | Pure modules first (move `fingerprint` to a pure module with identical bytes); project definitions, workflow write controller, project supervisor, workflow progress, dashboard overview server part | receipts/CAS/unknown-effect tests; No Project default; golden identity tests |
| S6c | One `SqliteClient` for `guidance.sqlite3` and one for `thread-settings.sqlite3`; all stores on them become Effects; every critical section becomes `withTransaction`; CC-GDB-IMPLICIT wrapped; ownership preload from the guidance layer; synchronous store API deleted | S1 atomicity/interruption tests green on the new engine; no `node:sqlite` import outside `@effect/sql-sqlite-node`; Docker build; VM cut-over proof |
| S7 | UI on Atom/AtomHttpApi after the Impeccable, modern-web-guidance and wcag-accessibility passes | atom-level tests; VM browser acceptance by the coordinator; Docker build |
| S8 | Remove superseded machinery; final lint bans (`Effect.run*` outside entry points, `setTimeout`/`setInterval` in `src`, `ws`/`node:sqlite`/`loadExtension` outside approved adapters); empty leak allowlist; README update | full suite, harness, build, Docker build; handoff to the coordinator for both-host deployment |

The order inside each slice follows the manifest (`order`). Slice counts by file: S0 61
(47 suites and the fixture, toolchain/config/CI, AGENTS.md, and two pure modules that
need no port: `supervisor-control-contract.ts`, `supervisor-observation.ts`), S2 11, S3 2, S4 6, S5 7, S6a 8,
S6b 13, S6c 9, S7 25, S8 17 (docs, skills and other preserved files re-checked at the end).

## 7. Live proof triggers (local coordinator only)

The remote owner cannot claim Mac or VM results. The coordinator runs these on the Lima VM
with existing fixtures, explicit IDs and budget. Only owned idle fixtures are cleaned up.
There are no seeded agreements, no protocol coaching and no first-tool barrier claims.

- **Early, on the baseline image, before S3/S4 ports** (reference behaviour):
  - Interrupt a root check-in, an introduction and a helper webhook POST between the
    `sending` record and the receipt (connection cut or process kill), then restart.
    Expect no duplicate native message, the original identity reconciled, and native
    message counts and timestamps recorded.
  - Stop a supervised fixture chat while a helper check-in is in flight. Expect one
    operative notice, no new helper POST, and settlement only after the accepted
    delivery's native outcome.
- **After S2:** `t3-supervisor auth forge` inside the deployment. Expect token-only
  stdout, the exit codes above, sign-in, and existing sessions surviving a restart.
  `docker stop` should give exit 130 with finalizers run.
- **After S3:** the ported build opens the existing state volume.
  - Catalog cursor continues (no rewind).
  - `login.sqlite3` stays in DELETE journal mode with byte-identical schema.
  - `-wal`/`-shm` modes are 0600.
  - Health reports ready.
- **After S4/S5:**
  - Real T3 watch: snapshot, then Ack, heartbeat over 60 s idle, reconnect after a T3
    restart.
  - A native read RPC and a git probe on a real checkout.
  - MCPX connecting directly to `/mcp/workflows`: initialize, tools/list and a bounded
    `workflow_read`. No session header, bearer only, Host allowlist, foreign Origin
    rejected.
- **After S6a/S6b:**
  - An uncoached operative request on an owned fixture chat. Record first edit,
    introduction and completed acceptance separately; inspect rendered prompts, traffic
    and repeated-message counts.
  - An uncoached No Project Start, then Stop during interpretation (exactly one notice).
  - A `workflow_write` through MCPX (first call may be pending; the identical retry
    applies once).
  - A trivial no-contact case.
- **After S6c:** cut-over on the Lab `guidance.sqlite3` under concurrent MCP writes and the
  supervision cycle.
  - No SQLITE_BUSY and no event-loop stall.
  - Pragmas unchanged; team, monitor and receipt rows intact.
  - Definitions revision identical to before the port.
- **After S7:** browser acceptance.
  - Sign-in; drafts survive session expiry and re-sign-in.
  - Start fence after an interrupted POST.
  - Stop/Enable.
  - Keyboard and focus behaviour.
- **Batch completion:** both-host deployment, state preservation, native MCP and browser
  acceptance, and Lab records (coordinator only).

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
| ref-counted per-key `Semaphore` with `acquireUseRelease` (`api/src/services/namespacedLock.ts`) | `RcMap<scopeKey, Semaphore>` for CC-SCOPE-SERIAL | `RcMap` (stable) gives the same release-on-last-user semantics without a hand-kept map |
| `SqliteClient.layer` + directory creation via `Layer.effectDiscard` (`api/src/lib/sql.ts`) | per-file client layers built once at the root | no `SqliteMigrator` (D-04); files created and chmodded 0600 before open; `FileSystem` instead of `fs.existsSync`; login DB `disableWAL` |
| error model (`wiki/architecture/error-model.md`): `Data.TaggedError` for local diagnostics, schema-backed errors at wire/persisted boundaries, translate at the boundary, inner `reason` unions, never stringify causes | section 3.10 | Scanner's `S.TaggedErrorClass` is an effect-app addition; core 4.0.1/4.0.5 only have `Schema.TaggedError` (`Schema.ts:16653`) |
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
| `src/workflow-mcp.ts` | `@modelcontextprotocol/sdk` stateless Streamable HTTP transport inside one Effect route | Effect `McpServer` is sessionful for all current protocol versions (D-03) | per-request scope; abort on client close |
| `src/service-auth.ts` | private-files adapter over `node:fs/promises` (O_NOFOLLOW/O_DIRECTORY/O_EXCL open, lstat dev/ino, fchmod, fsync, link) | `FileSystem` 4.0.5 has no lstat, those flags or handle chmod (`noFollow` covers only the final component on open) | `acquireRelease` per handle |
| `src/t3.ts`, `src/supervisor-native.ts`, `src/project-files.ts`, `src/git-probe.ts` | one custom `Socket.WebSocketConstructor` over `ws` (or a single envelope adapter if D-08 rejects `RpcClient`) | `NodeSocket` passes only headers: no `maxPayload`, and listener removal can leave a connecting socket's `error` unhandled | socket scope terminates on release |
| `src/supervisor-helper-transport.ts` | native T3 scheduled-task webhook POST via `HttpClient` | the only helper delivery channel; the path is a capability URL POSTed exactly once | request scope; no retry |
| `src/project-definitions.ts`, `src/project-config-editor.ts` | `yaml` `parseDocument`/`stringify` | comment-preserving YAML with duplicate-key detection has no Effect equivalent | pure (no resources) |
| `ui/src/access.ts` | `localStorage` + `storage` events + auth-required event | cross-tab semantics not provided by `KeyValueStore.layerStorage` | listener in the atom/runtime scope |
| `ui/src/navigation.tsx` | History API + hash events + restore timer around the deterministic navigator | no Effect platform service for history | listeners and timer released with the atom/component |
| `ui/src/main.tsx` | `beforeunload` and `document.title` | DOM lifetime side effects | effect cleanup (unchanged) |

The interim synchronous `guidance.sqlite3`/`thread-settings.sqlite3` API (S4-S6b) is not
an adapter: S6c deletes it.

## 10. AGENTS.md rule (added in S0)

S0 adds this rule to `AGENTS.md` and nothing else from the plan:

> **Effect v4 throughout.** The application, CLI, tooling and tests use Effect v4 at one
> exactly pinned version for `effect` and every `@effect/*` package. Write services as
> `Context.Service` with Layers, decode trust boundaries with `Schema`, persist through
> `effect/sql`, keep UI async state in Atom/AtomHttpApi, and test with `@effect/vitest`
> (`TestClock` for timing, `it.live` for real I/O). Do not call `Effect.run*` in business
> code or add Promise polling, ad hoc timers or hand-rolled async state machines.
> Third-party, native and browser integrations stay small scoped adapters with a recorded
> reason; pure calculations, types and JSX stay plain.

## 11. Non-code audit

Every non-code file has a disposition and rationale in the manifest (`auditRationale`).

- **Update:**
  - `package.json` and `package-lock.json`: exact pins.
  - `tsconfig.json`: include `vitest.config.ts`.
  - `eslint.config.js`: slice-by-slice bans using core rules only, no new plugin.
  - `.github/workflows/check.yml`: `timeout-minutes` and `test:harness`.
  - `AGENTS.md`: section 10.
  - `README.md`: S8. The development section names Vitest. The "same dependency lock"
    sentence in "Node security runtime" becomes stale and must distinguish the October
    Node rebuild from this dependency change.
- **Preserve:**
  - `PRODUCT.md`, `DESIGN.md`, `.impeccable/*`, `ui/index.html`, `ui/src/style.css` and
    the three PNG marks. These are byte-identical; no visual change and no mechanical
    asset edits.
  - Skills. They are portable product usage and nothing user-visible changes, so there is
    no Skillshare propagation.
  - Historical docs and proposals (`docs/guidance.md`, `docs/intent-guidance-review.md`,
    `docs/proposals/*`).
  - Behaviour docs (`docs/project-definitions.md`, `project-supervision.md`,
    `steps-and-workflows.md`, `supervisor-team.md`, `workflow-mcp.md`). These are
    re-checked in S8 only for mechanism wording, and they serve as the behavioural spec
    for characterization tests.
  - `Dockerfile`: Node 24.22.1 digest pins unchanged.
  - `compose.yaml`, `.env.example`, `.dockerignore`, `.gitignore`, `tsconfig.build.json`,
    `ui/tsconfig.json`, `ui/src/vite-env.d.ts`, `vite.config.ts`.
- **New files** (listed in `plannedNewFiles`): `vitest.config.ts`,
  `scripts/run-tests.mjs`, `test/support/leak-gate.ts`, `test/harness/*`,
  `test/support/*` layers.

## 12. Decisions

Genuine, needing reviewer alignment (and Andrea where noted):

| ID | Decision | Recommendation |
| --- | --- | --- |
| D-01 | Order for `guidance.sqlite3` and thread policy | controllers first with synchronous store calls only in `Effect.sync` critical sections; one S6c engine switch (section 3.4) |
| D-02 | CLI parsing (Andrea: CLI fully on Effect v4) | S2 spike of `effect/cli` with built-ins disabled and custom error rendering; adopt only if CT-CLI-01..05 pass byte-identical. Otherwise Schema-decoded argv plus an Effect program under `runMain`; either way no hand-written imperative CLI remains |
| D-03 | MCP transport | keep the SDK stateless transport as a scoped adapter; Effect owns route, auth, timeout and abort. Effect `McpServer` would force sessions on MCPX |
| D-07 | Stop window across two database files | stop list held in an in-memory snapshot updated right after each committed save; final check immediately before the native call with nothing in between; a forced-interleaving test pins that a Stop committed after the check behaves like a baseline in-flight send (reconciled, one notice). Closing the window completely is impossible without one transaction across files |
| D-08 | Native envelope | S4 spike: `RpcClient` over `Socket` against recorded T3 frames; adopt only if limits, Ack timing, close/terminate and the sent boundary are exact, else one shared Effect envelope adapter |

Owner defaults (reviewers may object):

- **D-04:** no `SqliteMigrator`. Keep the idempotent DDL, including the prototype
  `ALTER` guards; removing them is a separate data-safety ledger item.
- **D-05:** runner policy in 5.2.
- **D-06:** config parsing keeps baseline semantics (`preserveEmptyStrings`, `Number()`
  conversion).
- **D-09:** custom `WebSocketConstructor`.
- **D-10:** shutdown order with dependents first.
- **D-11:** remove the legacy `ui-login-code` deletion in S8 once the coordinator confirms
  the file is absent on both hosts.
- **D-12:** router-level auth middleware.
- **D-13:** MCP tool inputs decoded with `Schema` mapped to the existing reason codes. The
  advertised JSON Schemas stay byte-identical (golden test CT-WWC-06).
- **D-14:** stored JSON decoded with `Schema` that accepts every historically valid row and
  keeps the `incompatible` classification.
- **D-15:** IDs through `Crypto.randomUUIDv4`.
- **D-16:** webhook POST via `HttpClient`, with redirect and keep-alive behaviour pinned
  first.
- **D-17:** ownership preload from the guidance layer order.
- **D-18:** single-flight presence/activation semantics chosen after CT-PS-05.
- **D-19:** UI behaviour tested at atom level in Node with injected browser adapters, with
  no new DOM test dependency. Browser acceptance happens on the VM.
- **D-20:** 4.0.6 or later only as its own ledger item, once every companion is under
  `latest`.
- **D-21:** delete the write-only `pendingCandidates` (W3), and fix the phantom owned-ID
  rollback (W2) with CT-TCTRL-03. The fix is a behaviour change on rollback only and needs
  reviewer acknowledgement.
- **D-22:** the team-controller tests stay in `workflow-write-controller.test.ts` (name
  and file parity).

## 13. Findings and acceptance ledger (v1)

| ID | Source | Finding | Status |
| --- | --- | --- | --- |
| F-001 | Astra | Controllers share `guidance.sqlite3`; native proof, receipts, workflow edits and acknowledgements commit together; per-service clients would split atomicity; characterization must test real commit/rollback under concurrent Stop/CAS/interruption | incorporated (3.2 rule 1, 3.4, S1 wave item 1); verified per-client transaction key at `SqlClient.ts:179` |
| F-002 | Sol | `login.sqlite3` requires DELETE journal and an exact two-table schema; SqliteClient defaults to WAL; TestClock does not cover wire delivery | incorporated (3.2 table, CC-AUTH/CC-DBFILES, 5.2 item 5); verified `service-auth.ts:260-263` |
| F-003 | Sol, Astra | parity arithmetic: 6 parents contain 20 subtests (not 19); 843 + 6 = 849 top level, 843 + 20 = 863 leaves | corrected in v1 (section 1, 5.1, manifest `baseline.tests`) |
| F-004 | Sol | `detectAsyncLeaks` only reports; an explicit leak gate and an outer deadlock watchdog are needed; `testTimeout: 0` only for S0 parity | incorporated (5.2); independently reproduced (`/tmp/effv4-probe`) |
| F-005 | Owner | Vitest's 5 s default would fail 5 passing baseline tests | D-05 |
| F-006 | W1 | `SqliteClient` switches to WAL before a caller can chmod (fresh `-wal`/`-shm` modes) | CC-FILEMODES; files chmodded before open |
| F-007 | W1 | `effect/socket` + `NodeSocket`: no `maxPayload`, possible unhandled `ws` error on handshake timeout | 3.6, D-09 |
| F-008 | W1 | `effect/cli` cannot reproduce the CLI contract as is | D-02 |
| F-009 | W1 | Effect `McpServer` is sessionful for current protocol versions | D-03 |
| F-010 | W1, W2, W3 | many read-modify-write sequences rely on synchronous run-to-completion | CC-GDB-IMPLICIT, 3.3 |
| F-011 | Owner | Effect-typed store methods over `Effect.sync` can interleave inside an open transaction | D-01 interim uses whole-block `Effect.sync` sections |
| F-012 | W2 | phantom owned ID after an outer rollback (latent bug) | CT-TCTRL-03, D-21 |
| F-013 | W2, W3 | Stop list and send records live in different files; check-then-send was one synchronous tick | D-07 |
| F-014 | W3 | `ProjectSupervisor` constructor cycle | `SupervisionScope` service in S6a |
| F-015 | W3 | write-only `pendingCandidates` | D-21 |
| F-016 | Owner | native frames are the `effect/rpc` `RpcMessage` protocol, re-implemented six times | D-08, CC-WSFRAME |
| F-017 | Owner | `effect@4.0.6` is tagged on GitHub but absent from npm | version policy (section 2) |
| F-018 | Coordinator | Scanner reference must be current `main` c17ab1a (effect 4.0.1), not the stale beta.90 checkout | section 8; snapshot `/tmp/scanner-c17ab1a` |
| F-019 | Owner | Impeccable, modern-web-guidance and wcag-accessibility skills are not installed remotely | S7 entry condition |
| F-020 | Owner | bottom-up slices leave unported Promise callers of ported services for a while | section 3.9: bridges only in unported callers, ledgered with their removing slice, banned by S8 |

Acceptance cases for the whole batch (all must hold before handoff):

- **A-01:** 863 baseline leaf tests and 6 groups pass under Vitest with identical names.
- **A-02:** no unknown send is ever resent under a new identity.
- **A-03:** Stop and Enable semantics and notices are unchanged.
- **A-04:** No Project defaults to On request and shared definitions never activate it.
- **A-05:** existing state volumes open unchanged: schemas, journal modes, file modes,
  sessions, credentials, thread identities.
- **A-06:** the CLI contract is byte-identical, with no token leakage.
- **A-07:** MCPX reaches `/mcp/workflows` directly, statelessly, with the same
  authentication.
- **A-08:** dashboard drafts and auth behave as today.
- **A-09:** a trivial request causes no contact.
- **A-10:** no `Effect.run*` in business code (bridge list empty), no ad hoc timers or
  polling, and every residual adapter is listed in section 9.
