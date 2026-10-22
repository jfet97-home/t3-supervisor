# Runner self-tests

`npm run test:harness` runs these through the same watchdog as `npm test`, with
`vitest.harness.config.ts`. Each nested run uses `fixtures/vitest.fixture.config.ts`; the
`*.fixture.ts` files match neither the main nor the harness `include`.

- `leak-gate.test.ts`: the gate fails closed without `state.leakSet`, with detection disabled
  or with an invalid allowlist entry; allowances match kind, source and file up to their
  maximum count; a leaked interval fails a nested run even with `--reporter=json`; a clean
  run passes.
- `timeouts.test.ts`: a never-resolving Promise and `Effect.runPromise(Effect.never)` fail at
  their explicit per-test timeout; hanging and throwing finalizers fail at the fixture hook
  timeout.
- `watchdog.test.ts`: a synchronously blocked worker with a SIGTERM-ignoring grandchild is
  killed at the deadline (exit 124, SIGKILL escalation, no group member left); SIGINT and
  SIGTERM are forwarded to the group (exit 130 and 143); an invalid deadline option exits 2.

- `effect-timeout.test.ts`: an `@effect/vitest` per-test timeout interrupts the effect fiber
  and runs its finalizer; an in-effect `Effect.timeout` fails typed inside `it.live`.
- `leak-collect.test.ts`: an interrupted fiber is not reported, a still-referenced suspended
  fiber is, and a worker without `--expose-gc` fails closed.
- `handle-gate.test.ts`: the native resource gate of `vitest.cpu-bound.config.ts` fails a
  leaked interval and an open server, passes a closed server and fails closed without
  `process.getActiveResourcesInfo`.
- `node-test.test.ts`: the node:test cleanup-order shim of `test/support/node-test.ts`.
- `deadlines.test.ts`: both phase configs give every test Vitest's own 10 s timeout and no
  slower class; in a scaled nested run an unlisted test (an effect and a promise) times out
  at the default bound with its finalizer run, while an explicit slow bound is kept.
- `private-assert.test.ts`: token-bearing assertion failures (repeated token, token in
  stderr or stdout, secret in an error message, failed child process) still fail, and
  neither the console nor the json report carries a token.
- `lint-guards.test.ts`: the SQLite driver (barrel, subpath or re-export) is rejected outside
  `src/db.ts`, extension loading is rejected, and suites cannot import `node:test`.
- `phases.test.ts`: `npm test` is one watchdog over the main and cpu-bound phases; over two
  fixture phases (`fixtures/vitest.phase-{a,b}.config.ts`) a filter runs only the phases that
  select files, a location filter reaches only its file's phase, an empty selection fails as
  Vitest does, an explicit `--config` runs once, json reports stay per phase and combine
  without duplicates, a first or second phase failure stops the run with its code, one
  deadline spans both phases (the second gets the remainder; expiry starts no later phase)
  and SIGTERM in the second phase ends its group.
