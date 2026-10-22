import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { SupervisorConfig } from "../src/config.js";

// the helper instance id parsed from exactly the given environment, empty values kept as the process provider keeps them
const helperProviderInstanceId = (env: Record<string, string>) => Effect.gen(function* () {
  return (yield* SupervisorConfig).helperProviderInstanceId;
}).pipe(Effect.provide(SupervisorConfig.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }))))));

it.effect("helper provider isolation is opt-in and trims a bounded native instance ID", () => Effect.gen(function* () {
  assert.equal(yield* helperProviderInstanceId({}), undefined);
  assert.equal(yield* helperProviderInstanceId({ SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: " supervisor-helpers-20348 " }), "supervisor-helpers-20348");
  const failure = yield* Effect.flip(helperProviderInstanceId({ SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: "x".repeat(257) }));
  assert.match(failure.message, /invalid_helper_provider_instance_id/u);
}));
