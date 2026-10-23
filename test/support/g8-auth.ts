import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Clock, Context, Effect, Exit, FileSystem, Layer, Redacted, Scope } from "effect";
import { AccessDb, accessDbLayer } from "../../src/db.js";
import { forgeDashboardToken, ServiceAuth } from "../../src/service-auth.js";

// the service's grant lifetime and pending-grant cap (src/service-auth.ts)
const grantLifetime = 5 * 60 * 1_000;
const maxPendingGrants = 32;

// the service auth suites over the Effect service (test harness only): one instance is the layer built in its own scope
// under the caller's scope, so a test can release it early with `close` and the caller's scope releases it otherwise.
// grant and session values leave the service as redacted values; these helpers compare their plain text

export interface OpenServiceAuth {
  readonly service: ServiceAuth["Service"];
  login(token: string): Effect.Effect<string | null>;
  authenticated(session: string | undefined): Effect.Effect<boolean>;
  logout(session: string | undefined): Effect.Effect<void>;
  mcpAuthorized(authorization: string | undefined): boolean;
  // releases the instance; a second close does nothing
  readonly close: Effect.Effect<void>;
}

export const openServiceAuth = (dataDirectory: string) => Effect.gen(function* () {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const context = yield* Layer.buildWithScope(ServiceAuth.layer(dataDirectory), scope).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  const service = Context.get(context, ServiceAuth);
  const auth: OpenServiceAuth = {
    service,
    login: (token) => Effect.map(service.login(token), (session) => session === null ? null : Redacted.value(session)),
    authenticated: service.authenticated,
    logout: service.logout,
    mcpAuthorized: service.mcpAuthorized,
    close: Scope.close(scope, Exit.void),
  };
  return auth;
});

// a forged single-use grant as plain text with its deadline
export const forge = (dataDirectory: string) =>
  Effect.map(forgeDashboardToken(dataDirectory), (issued) => ({ token: Redacted.value(issued.token), expiresAt: issued.expiresAt }));

// setup grants for login fixtures whose subject is not issuance: `count` single-use grants in the service's format
// (canonical 32-byte base64url tokens stored as their sha256, the five-minute grant lifetime from the current clock)
// written in one transaction over one access client, instead of one forge each with its own short-lived client and
// database worker; it returns the plain tokens. cases about forging, pruning or the pending-grant cap keep the real forge
export const seedGrants = (dataDirectory: string, count: number) => Effect.gen(function* () {
  const db = yield* AccessDb;
  const now = yield* Clock.currentTimeMillis;
  const tokens = Array.from({ length: count }, () => randomBytes(32).toString("base64url"));
  yield* db.withTransaction(Effect.gen(function* () {
    yield* db`INSERT INTO dashboard_login_grants ${db.insert(tokens.map((token) =>
      ({ token_hash: createHash("sha256").update(token, "utf8").digest("hex"), issued_at: now, expires_at: now + grantLifetime })))}`;
    const [pending] = yield* db<{ readonly n: number }>`SELECT count(*) AS n FROM dashboard_login_grants`;
    if (Number(pending?.n) > maxPendingGrants) return yield* Effect.die(new Error("seeded grants beyond the pending-grant cap"));
  }));
  return tokens;
}).pipe(Effect.provide(Layer.fresh(accessDbLayer(join(dataDirectory, "access", "login.sqlite3")))));

// a private temporary directory removed with the caller's scope
export const temporaryDirectory = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});
