import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("Telegram is opt-in and its master setting overrides input relay", () => {
  const telegram = process.env.TELEGRAM_ENABLED;
  const input = process.env.INPUT_ENABLED;
  try {
    delete process.env.TELEGRAM_ENABLED;
    process.env.INPUT_ENABLED = "true";
    assert.equal(loadConfig().telegramEnabled, false);
    assert.equal(loadConfig().inputEnabled, false);
    process.env.TELEGRAM_ENABLED = "false";
    assert.equal(loadConfig().inputEnabled, false);
    process.env.TELEGRAM_ENABLED = "true";
    assert.equal(loadConfig().telegramEnabled, true);
    assert.equal(loadConfig().inputEnabled, true);
    process.env.INPUT_ENABLED = "false";
    assert.equal(loadConfig().inputEnabled, false);
  } finally {
    if (telegram === undefined) delete process.env.TELEGRAM_ENABLED;
    else process.env.TELEGRAM_ENABLED = telegram;
    if (input === undefined) delete process.env.INPUT_ENABLED;
    else process.env.INPUT_ENABLED = input;
  }
});

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
