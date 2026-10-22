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
