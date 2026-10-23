import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Ref, Schedule, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { SupervisorApi } from "../../src/guidance-contract.js";
import { SessionAccess } from "./access.js";
import { ApiClient, classifyMutation, sessionHttpClient, Unconfirmed, type MutationFailure } from "./api.js";

// the shared atom contract of the dashboard (plan 3.8): one page runtime with fixed layers, scope keys, visibility-aware
// polling, admitted mutations and keep-alive drafts; panels build their queries, mutations and drafts from these

// the page runtime; its layers are fixed when the registry is created and never replaced through registry initial values
// (#9313); the registry-scoped memo map shares one SessionAccess with ApiClient's own runtime
export const uiRuntime = Atom.runtime(Layer.mergeAll(
  Layer.effect(ApiClient, HttpApiClient.make(SupervisorApi, { baseUrl: globalThis.location?.origin })).pipe(Layer.provide(sessionHttpClient)),
  SessionAccess.layerBrowser,
));

// a stable family key from the parts a panel depends on (T3 environment, project, main chat, binding generation or
// checkout, section, auth epoch); undefined and null parts are kept distinct from empty strings
export const scopeKey = (...parts: ReadonlyArray<string | number | boolean | null | undefined>): string => JSON.stringify(parts);

// the session generation: it increases only when the stored session value actually changes (a sign-in with a new
// session, a sign-out or expiry that removes a present session, another tab's different value), never on a notification
// that leaves the value as it was, such as the access refresh after a 401 while already signed out; scoped reads follow
// it so a new session never sees an old session's read
export const authEpochAtom = uiRuntime.atom(Stream.unwrap(Effect.gen(function* () {
  const access = yield* SessionAccess;
  const initial = yield* access.session;
  return access.changes.pipe(
    Stream.mapEffect(() => access.session),
    Stream.scan(() => ({ session: initial, epoch: 0 }), (state, session: string) => session === state.session ? state : { session, epoch: state.epoch + 1 }),
    Stream.map((state) => state.epoch), Stream.changes, Stream.drop(1));
})), { initialValue: 0 });

// the current auth epoch, 0 before the first change
export const authEpoch = (get: Atom.AtomContext): number => Option.getOrElse(AsyncResult.value(get(authEpochAtom)), () => 0);

// the T3 environment of the root snapshot's latest successful read, null before the first; environment-scoped panels put
// it first in their scope keys. the root snapshot read sets it, so reading it never starts a read of its own
const environmentState = Atom.keepAlive(Atom.make<string | null>(null));
export const environmentAtom: Atom.Atom<string | null> = environmentState;

// the root snapshot read of the dashboard; it follows the auth epoch, so a sign-in reads it again, and a refresh or a new
// epoch keeps its last success while it reads
export const snapshotAtom = uiRuntime.atom((get) => {
  authEpoch(get);
  return Effect.flatMap(ApiClient, (client) => client.guidance.snapshot()).pipe(
    Effect.tap((snapshot) => Effect.sync(() => get.set(environmentState, snapshot.environmentId))));
});

// changes once per interval while the page is visible; a hidden tab skips the tick instead of catching up later, as the
// baseline interval checks did (document.hidden at each tick)
export const pollSignal = Atom.family((millis: number) => uiRuntime.atom(
  Stream.fromSchedule(Schedule.spaced(Duration.millis(millis))).pipe(
    Stream.filter(() => typeof document === "undefined" || document.visibilityState === "visible"),
    Stream.scan(() => 0, (tick: number) => tick + 1), Stream.drop(1)),
  { initialValue: 0 }));

// refreshes a read on every visible tick of the interval; the read keeps its last success while it refreshes or fails
export const pollWhileVisible = (millis: number) => Atom.makeRefreshOnSignal(pollSignal(millis));

// one user action: the scope it was started for and its operation id
export interface MutationKey {
  readonly scope: string;
  readonly operationId: string;
}

// the outcome of an admitted mutation, retained for its original scope until the panel discards it
export type MutationResult<A> = AsyncResult.AsyncResult<A, MutationFailure>;

// a family of admitted mutations keyed by scope and operation id (plan 3.8): the atom stays alive across unmount, scope
// changes, auth refreshes and refetches; writing it again while it runs joins the run already admitted instead of starting
// a second request; a finished operation is never replayed, a new attempt needs a new operation id; disposing the
// registry interrupts the request (aborting the fetch and running its finalizers) and records it as unconfirmed, since
// the server may have applied it. the claim belongs to the registry: each registry holds its own in a keep-alive atom of
// the family member, so at most one request per (scope, operation id) is sent in a registry and another registry starts
// the operation afresh
export const admittedMutation = <I, A, E, R extends ApiClient | SessionAccess>(
  run: (input: I) => Effect.Effect<A, E, R>,
) => {
  const family = Atom.family((_key: string) => {
    const claim = Atom.keepAlive(Atom.make(() => Ref.makeUnsafe(Option.none<Deferred.Deferred<A, MutationFailure>>())));
    // only the claim and the recording of the outcome are masked; the request and every wait stay interruptible
    return Atom.keepAlive(uiRuntime.fn((input: I, get) => {
      const admitted = get(claim);
      return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const own = yield* Deferred.make<A, MutationFailure>();
        const claimed = yield* Ref.modify(admitted, (current) => Option.isSome(current) ? [current.value, current] : [own, Option.some(own)]);
        if (claimed !== own) return yield* restore(Deferred.await(claimed));
        const exit = yield* Effect.exit(restore(classifyMutation(run(input))));
        yield* Deferred.done(own, Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Exit.fail(new Unconfirmed()) : exit);
        return yield* exit;
      }));
    }, { concurrent: true }));
  });
  return (key: MutationKey) => family(JSON.stringify([key.scope, key.operationId]));
};

// writes one admitted mutation and waits for its settled outcome. invoking an action again disposes the previous
// invocation's own context, so later get.set or get.setResult calls of that invocation are silently ignored; actions
// therefore write their mutations and outcomes through the registry
export const admit = <I, A, E>(registry: AtomRegistry.AtomRegistry, mutation: Atom.Writable<AsyncResult.AsyncResult<A, E>, I>, input: I) =>
  Effect.suspend(() => {
    registry.set(mutation, input);
    return AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true });
  });

// a keep-alive draft per scope key (without the auth epoch), so drafts survive navigation, unmount, session expiry and
// re-sign-in exactly as the baseline component state did; panels apply their own reset rules
export const draftFamily = <A>(initial: (key: string) => A) =>
  Atom.family((key: string) => Atom.keepAlive(Atom.make(initial(key))));
