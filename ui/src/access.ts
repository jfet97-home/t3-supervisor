import { Context, Data, Effect, Layer, PubSub, Schema, Stream } from "effect";

const sessionKey = "supervisor-session";
const CsrfAnswer = Schema.Struct({ csrf: Schema.String });
const isCsrfAnswer = Schema.is(CsrfAnswer);

// the stored session could not be saved; the message is the exact text the sign-in form shows
export class StorageBlocked extends Data.TaggedError("StorageBlocked") {
  override readonly message = "Your browser blocked saved sign-in. Allow site storage for Supervisor and try again.";
}

// the access check could not reach Supervisor or read its answer; the sign-in screen tells this apart from a signed-out
// session
export class AccessUnreachable extends Data.TaggedError("AccessUnreachable") {}

// why the stored session may have changed: another tab's storage event, an access check that found it expired, or this
// tab's sign-in or sign-out; a change may leave the stored value as it was
export type SessionChange = "storage" | "expired" | "signedIn" | "cleared";

export interface SessionAccessShape {
  // the session stored for this browser, empty when signed out or when storage is blocked
  readonly session: Effect.Effect<string>;
  // the headers every dashboard request carries
  readonly headers: Effect.Effect<Readonly<Record<"x-supervisor-session" | "x-csrf-token", string>>>;
  // reads the CSRF token for the current session; a stale answer is ignored, a 401 clears only the session that asked
  // and announces its expiry, and an unreachable server or an unreadable answer fails
  readonly check: Effect.Effect<boolean, AccessUnreachable>;
  // the check with an unreachable server read as not signed in, as the access refresh of every request needs it
  readonly load: Effect.Effect<boolean>;
  // stores the session of a verified sign-in result
  readonly signIn: (session: string) => Effect.Effect<void, StorageBlocked>;
  // forgets the session and its CSRF token, only while the stored session is still `expected`
  readonly clear: (expected?: string) => Effect.Effect<void>;
  // one element for every notification that the stored session may have changed; the auth epoch counts the actual
  // changes of the stored value
  readonly changes: Stream.Stream<SessionChange>;
}

// browser sign-in state for the page runtime: the session lives in localStorage (shared by the tabs of this browser) and
// its CSRF token in the service; the storage-event listener is the residual browser adapter of plan section 9 and is
// released with the runtime
export class SessionAccess extends Context.Service<SessionAccess, SessionAccessShape>()("t3-supervisor-ui/SessionAccess") {
  static readonly layerBrowser: Layer.Layer<SessionAccess> = Layer.effect(SessionAccess, Effect.gen(function* () {
    // the CSRF token of the stored session, empty until an access check reads it
    let csrf = "";
    const changed = yield* Effect.acquireRelease(PubSub.unbounded<SessionChange>(), PubSub.shutdown);
    const announce = (change: SessionChange) => PubSub.publish(changed, change);
    const stored = (): string => {
      try { return localStorage.getItem(sessionKey) ?? ""; } catch { return ""; }
    };
    const forget = (expected: string) => {
      if (stored() !== expected) return;
      csrf = "";
      try { localStorage.removeItem(sessionKey); } catch { /* storage can be blocked */ }
    };
    if (typeof window !== "undefined") {
      yield* Effect.acquireRelease(Effect.sync(() => {
        // another tab changed the stored session: its CSRF token is invalid at once
        const listener = (event: StorageEvent) => {
          if (event.storageArea !== localStorage || (event.key !== sessionKey && event.key !== null)) return;
          csrf = "";
          PubSub.publishUnsafe(changed, "storage");
        };
        const target = window;
        target.addEventListener("storage", listener);
        return () => target.removeEventListener("storage", listener);
      }), (release) => Effect.sync(release));
    }
    const check = Effect.gen(function* () {
      const session = stored();
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch("/api/csrf", { credentials: "omit", headers: { "x-supervisor-session": session }, signal }),
        catch: () => new AccessUnreachable(),
      });
      if (session !== stored()) return false;
      if (!response.ok) {
        csrf = "";
        if (response.status === 401 && typeof window !== "undefined") {
          forget(session);
          window.dispatchEvent(new Event("supervisor-auth-required"));
          yield* announce("expired");
        }
        return false;
      }
      const value: unknown = yield* Effect.tryPromise({ try: () => response.json(), catch: () => new AccessUnreachable() });
      if (session !== stored() || !isCsrfAnswer(value)) return false;
      csrf = value.csrf;
      return true;
    });
    return SessionAccess.of({
      session: Effect.sync(stored),
      headers: Effect.sync(() => ({ "x-supervisor-session": stored(), "x-csrf-token": csrf })),
      check,
      load: Effect.orElseSucceed(check, () => false),
      signIn: (session) => Effect.try({ try: () => localStorage.setItem(sessionKey, session), catch: () => new StorageBlocked() }).pipe(
        Effect.andThen(announce("signedIn"))),
      clear: (expected) => Effect.sync(() => forget(expected ?? stored())).pipe(Effect.andThen(announce("cleared"))),
      changes: Stream.fromPubSub(changed),
    });
  }));
}
