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
