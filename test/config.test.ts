import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("helper provider isolation is opt-in and trims a bounded native instance ID", () => {
  const configured = process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID;
  try {
    delete process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID;
    assert.equal(loadConfig().helperProviderInstanceId, undefined);
    process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID = " supervisor-helpers-20348 ";
    assert.equal(loadConfig().helperProviderInstanceId, "supervisor-helpers-20348");
    process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID = "x".repeat(257);
    assert.throws(() => loadConfig(), /invalid_helper_provider_instance_id/u);
  } finally {
    if (configured === undefined) delete process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID;
    else process.env.SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID = configured;
  }
});
