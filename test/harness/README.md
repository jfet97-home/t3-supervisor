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

Deferred to S1c (needs `@effect/vitest` 4.0.5): an `it.effect` per-test timeout interrupts
the fiber and runs its finalizers.
