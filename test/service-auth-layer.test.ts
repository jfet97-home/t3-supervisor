import assert from "node:assert/strict";
import { join } from "node:path";
import { inspect } from "node:util";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Redacted, Scope } from "effect";
import { TestClock } from "effect/testing";
import { forgeDashboardToken, ServiceAuth } from "../src/service-auth.js";
import { openDescriptors } from "./support/c3b-http.js";
import { privately } from "./support/private-assert.js";

// target regressions of the Effect service auth: the wall clock comes from Clock, the layer's scope bounds its one
// access client, and tokens leave the service only as redacted values

const temporaryDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-supervisor-service-auth-" });
});

describe("ServiceAuth", () => {
  it.effect("TestClock drives the service: a session is accepted 60000 ms before its issue time, rejected 60001 ms before it, and a grant is rejected exactly at its expiry", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const issuedAt = 1_000_000;
      yield* TestClock.setTime(issuedAt);
      const observed = yield* Effect.gen(function* () {
        const auth = yield* ServiceAuth;
        const grant = yield* forgeDashboardToken(directory);
        const session = yield* auth.login(Redacted.value(grant.token));
        if (session === null) return yield* Effect.die(new Error("a valid grant was rejected"));
        const window: Array<[number, boolean]> = [];
        for (const offset of [0, -60_000, -60_001, 30 * 24 * 60 * 60 * 1_000 - 1, 30 * 24 * 60 * 60 * 1_000]) {
          yield* TestClock.setTime(issuedAt + offset);
          window.push([offset, yield* auth.authenticated(Redacted.value(session))]);
        }
        yield* TestClock.setTime(issuedAt);
        const expiring = yield* forgeDashboardToken(directory);
        yield* TestClock.setTime(expiring.expiresAt);
        const atExpiry = yield* auth.login(Redacted.value(expiring.token));
        yield* TestClock.setTime(expiring.expiresAt - 1);
        const beforeExpiry = yield* auth.login(Redacted.value(expiring.token));
        return { grantExpiresAt: grant.expiresAt, window, atExpiry, beforeExpiry: beforeExpiry !== null };
      }).pipe(Effect.provide(ServiceAuth.layer(directory)));
      assert.deepEqual(observed, {
        grantExpiresAt: issuedAt + 5 * 60 * 1_000,
        window: [[0, true], [-60_000, true], [-60_001, false], [30 * 24 * 60 * 60 * 1_000 - 1, true], [30 * 24 * 60 * 60 * 1_000, false]],
        atExpiry: null,
        beforeExpiry: true,
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

  it.live("releasing the layer closes its one access client and every later check fails closed without touching the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* temporaryDirectory;
      const database = join(directory, "access", "login.sqlite3");
      const scope = yield* Scope.make();
      const auth = Context.get(yield* Layer.buildWithScope(ServiceAuth.layer(directory), scope), ServiceAuth);
      const workflowToken = yield* fs.readFileString(join(directory, "access", "workflow-mcp-token"));
      const first = yield* forgeDashboardToken(directory);
      const session = yield* auth.login(Redacted.value(first.token));
      const open = {
        descriptors: openDescriptors(database),
        session: session !== null,
        authenticated: session !== null && (yield* auth.authenticated(Redacted.value(session))),
        mcp: auth.mcpAuthorized(`Bearer ${workflowToken}`),
      };

      const pending = yield* forgeDashboardToken(directory);
      yield* Scope.close(scope, Exit.void);
      const released = {
        descriptors: openDescriptors(database),
        login: yield* auth.login(Redacted.value(pending.token)),
        authenticated: session !== null && (yield* auth.authenticated(Redacted.value(session))),
        mcp: auth.mcpAuthorized(`Bearer ${workflowToken}`),
      };
      yield* auth.logout(session === null ? undefined : Redacted.value(session));

      // the released service neither consumed the pending grant nor revoked the session
      const reopened = yield* Effect.gen(function* () {
        const again = yield* ServiceAuth;
        return {
          authenticated: session !== null && (yield* again.authenticated(Redacted.value(session))),
          login: (yield* again.login(Redacted.value(pending.token))) !== null,
        };
      }).pipe(Effect.provide(ServiceAuth.layer(directory)));
      privately("released service auth", [workflowToken], () => {
        assert.deepEqual(open, { descriptors: 1, session: true, authenticated: true, mcp: true });
        assert.deepEqual(released, { descriptors: 0, login: null, authenticated: false, mcp: false });
        assert.deepEqual(reopened, { authenticated: true, login: true });
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });

  it.live("forged tokens and sessions are redacted values: their rendering, json and inspection never show the token", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const { grant, session } = yield* Effect.gen(function* () {
        const auth = yield* ServiceAuth;
        const grant = yield* forgeDashboardToken(directory);
        const value = Redacted.value(grant.token);
        return { grant, session: yield* auth.login(value) };
      }).pipe(Effect.provide(ServiceAuth.layer(directory)));
      if (session === null) return yield* Effect.die(new Error("a valid grant was rejected"));
      const secrets = [Redacted.value(grant.token), Redacted.value(session)];
      const renderings = [grant, session].flatMap((value) => [String(value), JSON.stringify(value), inspect(value, { depth: 5 })]);
      privately("redacted values", secrets, () => {
        assert.deepEqual(secrets.map((secret) => /^[A-Za-z0-9_-]{43}$/u.test(secret)), [true, true]);
        assert.deepEqual(renderings.filter((text) => secrets.some((secret) => text.includes(secret))).length, 0);
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)), { timeout: 10_000 });
});
