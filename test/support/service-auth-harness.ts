import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Context, Effect, Exit, Layer, Redacted, Scope } from "effect";
import { startGuidanceUi as startGuidanceUiWith } from "../../src/guidance-ui.js";
import { forgeDashboardToken as forge, ServiceAuth as ServiceAuthService } from "../../src/service-auth.js";

// the baseline call shapes of the auth suites over the Effect API (test harness only): a service instance is the
// layer built in its own scope, its checks run to completion on the calling thread, and close releases the scope

export interface ServiceAuthOptions {
  now?: () => number;
}

export interface ServiceAuth {
  login(token: string): string | null;
  authenticated(session: string | undefined): boolean;
  logout(session: string | undefined): void;
  mcpAuthorized(authorization: string | undefined): boolean;
  close(): void;
  readonly service: ServiceAuthService["Service"];
}

// the wall clock read through `now`; nanoseconds and sleeps stay on the live clock
const clockFrom = (now: () => number): Clock.Clock => {
  const live = Clock.Clock.defaultValue();
  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
};

const withClock = (options: ServiceAuthOptions) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  options.now === undefined ? effect : Effect.provideService(effect, Clock.Clock, clockFrom(options.now));

export const createServiceAuth = async (dataDirectory: string, options: ServiceAuthOptions = {}): Promise<ServiceAuth> => {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(ServiceAuthService.layer(dataDirectory).pipe(Layer.provide(NodeFileSystem.layer)), scope))
    .catch(async (error: unknown) => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    });
  const service = Context.get(context, ServiceAuthService);
  const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(withClock(options)(effect));
  return {
    service,
    login: (token) => {
      const session = run(service.login(token));
      return session === null ? null : Redacted.value(session);
    },
    authenticated: (session) => run(service.authenticated(session)),
    logout: (session) => run(service.logout(session)),
    mcpAuthorized: (authorization) => service.mcpAuthorized(authorization),
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

export const forgeDashboardToken = (dataDirectory: string, options: ServiceAuthOptions = {}): Promise<{ token: string; expiresAt: number }> =>
  Effect.runPromise(forge(dataDirectory).pipe(
    withClock(options),
    Effect.map((issued) => ({ token: Redacted.value(issued.token), expiresAt: issued.expiresAt })),
    Effect.provide(NodeFileSystem.layer),
  ));

type UiArguments = Parameters<typeof startGuidanceUiWith> extends [infer C, infer G, unknown, unknown, ...infer Rest] ? [C, G, ...Rest] : never;

// the dashboard server over its own service auth, acquired before the listeners and released after them as the
// supervision run does; a failed start releases it before rejecting
export const startGuidanceUi = async (...[config, runtime, ...rest]: UiArguments) => {
  const auth = await createServiceAuth(config.dataDirectory);
  let ui: Awaited<ReturnType<typeof startGuidanceUiWith>>;
  try {
    ui = await startGuidanceUiWith(config, runtime, auth.service, Effect.runPromise, ...rest);
  } catch (error) {
    auth.close();
    throw error;
  }
  return {
    ...ui,
    close: async () => {
      try {
        await ui.close();
      } finally {
        auth.close();
      }
    },
  };
};
