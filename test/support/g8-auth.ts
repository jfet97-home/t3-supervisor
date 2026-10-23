import { Context, Effect, Exit, FileSystem, Layer, Redacted, Scope } from "effect";
import { forgeDashboardToken, ServiceAuth } from "../../src/service-auth.js";

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

// a private temporary directory removed with the caller's scope
export const temporaryDirectory = (prefix: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});
