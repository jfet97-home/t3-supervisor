import { Cause, Effect } from "effect";
import { redact } from "./private-assert.js";

// `privately` for an effect (test harness only): any failure or defect of `effect`, its own operation or a check on its
// value, becomes a fresh defect carrying only the label and the redacted message, never the original cause, so a private
// value inside it reaches neither the logged cause nor the test report; an interruption stays an interruption
export const privatelyEffect = <A, E, R>(label: string, secrets: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
  Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
    const error = Cause.squash(cause);
    return Effect.die(new Error(`${label}: ${redact(error instanceof Error ? error.message : String(error), secrets)}`));
  });
