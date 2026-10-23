import { Cause, Data, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { AtomHttpApi } from "effect/reactivity";
import { SupervisorApi } from "../../src/guidance-contract.js";

import { SessionAccess } from "./access.js";

// every dashboard request: no cookies, and the session and CSRF headers read from SessionAccess when the request is sent
export const sessionHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(HttpClient.HttpClient, Effect.gen(function* () {
  const access = yield* SessionAccess;
  const client = yield* HttpClient.HttpClient;
  return client.pipe(HttpClient.mapRequestEffect((request) =>
    Effect.map(access.headers, (headers) => HttpClientRequest.setHeaders(request, headers))));
})).pipe(
  Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" })))),
  Layer.provide(SessionAccess.layerBrowser),
);

export class ApiClient extends AtomHttpApi.Service<ApiClient>()(
  "SupervisorUiApi",
  {
    api: SupervisorApi,
    baseUrl: globalThis.location?.origin,
    httpClient: sessionHttpClient,
  },
) {}

// why a mutation was definitely not performed; each panel keeps its own golden text for each reason
export type MutationRefusal = "refreshed" | "refresh_failed" | "too_large" | "format";

// the server refused the request before acting on it: the draft or change is kept and the user may try again
export class NotPerformed extends Data.TaggedError("NotPerformed")<{ readonly reason: MutationRefusal }> {}

// the request may have been applied: nothing replays it; the panel blocks until a verified read
export class Unconfirmed extends Data.TaggedError("Unconfirmed") {}

export type MutationFailure = NotPerformed | Unconfirmed;

// the response behind a client failure: a declared error status arrives as StatusCodeError, an undeclared one
// (401, 403, 413, 415, 500) as DecodeError; both carry the response and, on it, the request as it was sent
const responseOf = (failure: unknown) => {
  if (!HttpClientError.isHttpClientError(failure)) return undefined;
  const reason = failure.reason;
  return reason._tag === "StatusCodeError" || reason._tag === "DecodeError" ? reason.response : undefined;
};

// the baseline outcome rules of every mutation helper (CT-UI-API-01): 401 and 403 refresh access and report whether the
// refresh worked, 413 and 415 are refusals, and any other failure, status, transport or decode error is unconfirmed;
// failures surfaced as defects by AtomHttpApi are classified the same way, interruption stays interruption.
// fetch shows only the last attempt of a request: a browser that resends it after a dropped connection repeats the
// original headers, so when the stored session changed while the request was out (another tab signed out, an expiry
// this tab saw, a new sign-in) a 401 or 403 does not show that the first attempt was refused, and the outcome stays
// unconfirmed
export const classifyMutation = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, MutationFailure, R | SessionAccess> =>
  self.pipe(Effect.catchCause((cause): Effect.Effect<never, MutationFailure, SessionAccess> => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
    const response = responseOf(Cause.squash(cause));
    const status = response?.status;
    if (response && (status === 401 || status === 403))
      return Effect.flatMap(SessionAccess, (access) => Effect.gen(function* () {
        const changed = response.request.headers["x-supervisor-session"] !== (yield* access.session);
        const refreshed = yield* access.load;
        return yield* changed ? new Unconfirmed() : new NotPerformed({ reason: refreshed ? "refreshed" : "refresh_failed" });
      }));
    if (status === 413) return Effect.fail(new NotPerformed({ reason: "too_large" }));
    if (status === 415) return Effect.fail(new NotPerformed({ reason: "format" }));
    return Effect.fail(new Unconfirmed());
  }));
