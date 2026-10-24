import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { buildInfo } from "../../src/version.js";
import { httpGet, type RunningProcess } from "./g8-process.js";
import { waitUntilReady, type SupervisorHarness } from "./g8-cli.js";

// shared by the archive regression and release artifact checks; all requests hit the running service
export const verifyReleaseDashboard = (harness: SupervisorHarness, child: RunningProcess) => Effect.gen(function* () {
  const health = yield* waitUntilReady(harness, child);
  const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String, revision: Schema.NullOr(Schema.String) })))(health.body);
  assert.equal(metadata.version, buildInfo.version);
  assert.equal(metadata.revision, buildInfo.gitHead ?? null);
  const dashboard = yield* httpGet(`http://127.0.0.1:${harness.ports.ui}/`, 5_000);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /<html/u);
  const asset = /src="(\/assets\/[^"/]+\.js)"/u.exec(dashboard.body)?.[1];
  assert.ok(asset, "the packaged HTML references a built JavaScript asset");
  const javascript = yield* httpGet(`http://127.0.0.1:${harness.ports.ui}${asset}`, 5_000);
  assert.equal(javascript.status, 200);
  assert.ok(javascript.body.length > 1_000);
  assert.doesNotMatch(javascript.body, /<!doctype html>/iu);
});
