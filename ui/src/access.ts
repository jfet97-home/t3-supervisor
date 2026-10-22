import { Context, Data, Effect, Layer, PubSub, Stream } from "effect";

let csrf = "";
export const getCsrfToken = () => csrf;
const sessionKey = "supervisor-session";
export const getSessionToken = () => {
  try { return localStorage.getItem(sessionKey) ?? ""; } catch { return ""; }
};
export const setSessionToken = (session: string) => {
  try { localStorage.setItem(sessionKey, session); }
  catch { throw new Error("Your browser blocked saved sign-in. Allow site storage for Supervisor and try again."); }
};
export const watchSession = (changed: () => void) => {
  const listener = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === sessionKey || event.key === null)) {
      csrf = "";
      changed();
    }
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
};
export const sessionHeaders = () => ({"x-supervisor-session": getSessionToken()});

export const loadAccess = async (): Promise<boolean> => {
  const session = getSessionToken();
  const response = await fetch("/api/csrf", {credentials: "omit", headers: {"x-supervisor-session": session}});
  if (session !== getSessionToken()) return false;
  if (!response.ok) {
    csrf = "";
    if (response.status === 401 && typeof window !== "undefined") {
      clearAccess(session);
      window.dispatchEvent(new Event("supervisor-auth-required"));
    }
    return false;
  }
  const value: unknown = await response.json();
  if (session !== getSessionToken()) return false;
  if (typeof value !== "object" || value === null || !("csrf" in value) || typeof value.csrf !== "string") return false;
  csrf = value.csrf;
  return true;
};

export const clearAccess = (expectedSession = getSessionToken()) => {
  if (getSessionToken() === expectedSession) {
    csrf = "";
    try { localStorage.removeItem(sessionKey); } catch { /* storage can be blocked */ }
  }
};

// the stored session could not be saved; the message is the exact text the sign-in form shows
export class StorageBlocked extends Data.TaggedError("StorageBlocked") {
  override readonly message = "Your browser blocked saved sign-in. Allow site storage for Supervisor and try again.";
}

export interface SessionAccessShape {
  // the session stored for this browser, empty when signed out or when storage is blocked
  readonly session: Effect.Effect<string>;
  // the headers every dashboard request carries
  readonly headers: Effect.Effect<Readonly<Record<"x-supervisor-session" | "x-csrf-token", string>>>;
  // reads the CSRF token for the current session; a stale answer is ignored and a 401 clears only the session that asked
  readonly load: Effect.Effect<boolean>;
  // stores the session of a verified sign-in result
  readonly signIn: (session: string) => Effect.Effect<void, StorageBlocked>;
  // forgets the session and its CSRF token, only while the stored session is still `expected`
  readonly clear: (expected?: string) => Effect.Effect<void>;
  // one element whenever the stored session changes (sign-in, sign-out, another tab, expiry); scoped reads key on it
  readonly changes: Stream.Stream<void>;
}

// browser sign-in state for the page runtime; the storage, storage-event and auth-required listeners are the residual
// browser adapter of plan section 9 and are released with the runtime
// transitional within S7: the operations delegate to the module functions above until every caller uses this service;
// the S7 cleanup moves the session and CSRF state into the service and deletes the module functions (no dual path at
// the S7 freeze)
export class SessionAccess extends Context.Service<SessionAccess, SessionAccessShape>()("t3-supervisor-ui/SessionAccess") {
  static readonly layerBrowser: Layer.Layer<SessionAccess> = Layer.effect(SessionAccess, Effect.gen(function* () {
    const changed = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
    if (typeof window !== "undefined") {
      yield* Effect.acquireRelease(Effect.sync(() => {
        const notify = () => { PubSub.publishUnsafe(changed, undefined); };
        const stopWatching = watchSession(notify);
        window.addEventListener("supervisor-auth-required", notify);
        return () => { stopWatching(); window.removeEventListener("supervisor-auth-required", notify); };
      }), (release) => Effect.sync(release));
    }
    const announce = PubSub.publish(changed, undefined);
    return SessionAccess.of({
      session: Effect.sync(getSessionToken),
      headers: Effect.sync(() => ({ "x-supervisor-session": getSessionToken(), "x-csrf-token": getCsrfToken() })),
      load: Effect.tryPromise(loadAccess).pipe(Effect.orElseSucceed(() => false)),
      signIn: (session) => Effect.try({ try: () => setSessionToken(session), catch: () => new StorageBlocked() }).pipe(Effect.andThen(announce)),
      clear: (expected) => Effect.sync(() => clearAccess(expected)).pipe(Effect.andThen(announce)),
      changes: Stream.fromPubSub(changed),
    });
  }));
}
