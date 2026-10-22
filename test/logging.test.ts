import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger } from "effect";
import { HttpServerError } from "effect/http";
import { TestClock, TestConsole } from "effect/testing";
import { InvalidConfiguration, T3TokenUnavailable } from "../src/errors.js";
import { jsonLogger, logEvent } from "../src/logging.js";
import { reportFailure, SupervisorLive } from "../src/supervisor.js";

// secrets as a nested failure would carry them: a token, a native error body and a webhook capability URL
const token = "Zq3x9VbN2mK7pL4tR8wY1cH6jD5sF0gAuE";
const nativeBody = "native-provider-error-body-7f3e2a91c4";
const webhookPath = "/api/hooks/supervisor-helper-1a2b3c4d/Kp9Qw2Er7Ty4Ui1Op8As5Df3Gh6Jk0Lz";
const webhookUrl = `http://127.0.0.1:3773${webhookPath}`;
const secrets = [token, nativeBody, webhookPath];

const nested = () => new Error(`upstream ${nativeBody}`, { cause: { authorization: `Bearer ${token}`, webhook: webhookUrl } });

const leaks = (lines: ReadonlyArray<unknown>) => secrets.filter((secret) => lines.some((line) => String(line).includes(secret)));

it.effect("logEvent writes one line in today's shape: time from the Clock, then the event, then the fields in order", () => Effect.gen(function* () {
  yield* TestClock.adjust("1500 millis");
  yield* logEvent("operation_deferred", { phase: "t3_stream", attempt: 2, connected: false, previous: null });
  yield* logEvent("supervisor_started");
  assert.deepEqual(yield* TestConsole.logLines, [
    `{"time":"1970-01-01T00:00:01.500Z","event":"operation_deferred","phase":"t3_stream","attempt":2,"connected":false,"previous":null}`,
    `{"time":"1970-01-01T00:00:01.500Z","event":"supervisor_started"}`,
  ]);
}), { timeout: 10_000 });

it.effect("logEvent passes the event and every string field through the credential redaction", () => Effect.gen(function* () {
  yield* logEvent(`delivery_failed Bearer ${token}`, { detail: `Authorization: Bearer ${token}`, query: `token=${token}`, size: 43 });
  const lines = yield* TestConsole.logLines;
  assert.deepEqual(lines, [
    `{"time":"1970-01-01T00:00:00.000Z","event":"delivery_failed [redacted credential]","detail":"Authorization: [redacted credential]","query":"token=[redacted]","size":43}`,
  ]);
  assert.deepEqual(leaks(lines), []);
}), { timeout: 10_000 });

it.effect("jsonLogger writes the same shape and never a cause, span or structured value", () => Effect.gen(function* () {
  yield* TestClock.adjust("2 seconds");
  yield* Effect.fail(nested()).pipe(
    Effect.catchCause((cause) => Effect.logError("supervision_unavailable", cause, nested())),
    Effect.annotateLogs({ phase: "t3_stream", status: 503, retrying: true, detail: { authorization: `Bearer ${token}` }, hooks: [webhookUrl] }),
    Effect.withSpan("supervision", { attributes: { webhook: webhookUrl, body: nativeBody } }),
  );
  // a record without a text message is named by its level
  yield* Effect.logWarning(Cause.fail(nested()));
  const lines = yield* TestConsole.logLines;
  assert.deepEqual(lines, [
    `{"time":"1970-01-01T00:00:02.000Z","event":"supervision_unavailable","phase":"t3_stream","status":503,"retrying":true}`,
    `{"time":"1970-01-01T00:00:02.000Z","event":"warn"}`,
  ]);
  assert.deepEqual(leaks(lines), []);
}).pipe(Effect.provide(Logger.layer([jsonLogger]))), { timeout: 10_000 });

it.effect("reportFailure prints one classified line per failure, without its cause, and nothing for an interruption", () => Effect.gen(function* () {
  yield* reportFailure(Cause.fail(new T3TokenUnavailable()));
  yield* reportFailure(Cause.fail(new InvalidConfiguration({ reason: "invalid_helper_provider_instance_id" })));
  yield* reportFailure(Cause.fail(new HttpServerError.ServeError({ cause: nested() })));
  yield* reportFailure(Cause.die(nested()));
  yield* reportFailure(Cause.interrupt());
  const lines = yield* TestConsole.logLines;
  assert.deepEqual(lines, [
    `{"time":"1970-01-01T00:00:00.000Z","event":"supervisor_failed","reason":"t3_token_unavailable"}`,
    `{"time":"1970-01-01T00:00:00.000Z","event":"supervisor_failed","reason":"invalid_helper_provider_instance_id"}`,
    `{"time":"1970-01-01T00:00:00.000Z","event":"supervisor_failed","reason":"health_listener_unavailable"}`,
    `{"time":"1970-01-01T00:00:00.000Z","event":"supervisor_failed","reason":"supervisor_failed"}`,
  ]);
  assert.deepEqual(leaks(lines), []);
}), { timeout: 10_000 });

it.live("a missing T3 token fails the server graph with T3TokenUnavailable, which carries no path or cause", () => Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "logging-token-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
  const tokenFile = join(directory, "t3-read-token-path-canary");
  const provider = ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DATA_DIRECTORY: join(directory, "data"), T3_TOKEN_FILE: tokenFile }));
  const exit = yield* Effect.exit(Layer.build(SupervisorLive.pipe(Layer.provide(provider))));
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.squash(exit.cause);
  assert.ok(failure instanceof T3TokenUnavailable);
  assert.equal(failure.cause, undefined);
  assert.deepEqual({ ...failure }, { reason: "t3_token_unavailable", _tag: "T3TokenUnavailable" });
  for (const rendered of [inspect(failure, { depth: 20 }), JSON.stringify(failure), String(failure), Cause.pretty(exit.cause)]) {
    assert.equal(rendered.includes("path-canary"), false, rendered);
    assert.equal(rendered.includes(directory), false, rendered);
  }
  // the classified startup line names only the reason
  const lines = yield* reportFailure(exit.cause).pipe(Effect.andThen(TestConsole.logLines), Effect.provide(TestConsole.layer));
  assert.equal(lines.length, 1);
  const fields = JSON.parse(String(lines[0])) as Record<string, unknown>;
  assert.equal(typeof fields.time, "string");
  assert.deepEqual({ ...fields, time: "<time>" }, { time: "<time>", event: "supervisor_failed", reason: "t3_token_unavailable" });
}), { timeout: 10_000 });
