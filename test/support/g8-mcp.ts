import assert from "node:assert/strict";
import { Cause, Clock, Deferred, Effect, Exit } from "effect";
import type { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import type { WorkflowCallCancel, WorkflowWriteController } from "../../src/workflow-write-controller.js";

// the workflow MCP route's controller tools as plain effects (test harness only). The route ends a call in two ways, and
// a gate tool reports which one under the baseline abort reason names: the 9 s deadline completes the call's soft cancel
// ("TimeoutError"), and the request's end or close() interrupts the call ("AbortError")

// one controller tool: its arguments and the soft cancel of its call
export type EffectTool = (args: unknown, cancel?: WorkflowCallCancel) => Effect.Effect<unknown>;

const missing: EffectTool = () => Effect.die(new Error("no such fake tool"));

// the write controller's four tools; a tool without a fake dies when called
export const effectWorkflowController = (tools: {readTool?: EffectTool; write?: EffectTool; startSupervision?: EffectTool; stopSupervision?: EffectTool}):
  WorkflowWriteController["Service"] => ({
    readTool: tools.readTool ?? missing,
    write: tools.write ?? missing,
    startSupervision: tools.startSupervision ?? missing,
    stopSupervision: tools.stopSupervision ?? missing,
  }) as unknown as WorkflowWriteController["Service"];

// the team controller's two tools
export const effectTeamController = (tools: {call?: EffectTool; guide?: EffectTool}): SupervisorTeamController["Service"] => ({
  call: tools.call ?? missing,
  guide: tools.guide ?? missing,
}) as unknown as SupervisorTeamController["Service"];

export interface Ended {
  // the baseline abort reason name of how the route ended the call
  readonly reason: "TimeoutError" | "AbortError";
  // the clock reading when the tool saw it
  readonly at: number;
}

export interface GateTool {
  // the clock reading when the call entered the tool
  readonly entered: Effect.Effect<number>;
  // how and when the end of the call reached the handler (the baseline's signal.reason and the abort time)
  readonly ended: Effect.Effect<Ended>;
  // the end has reached the handler (the baseline's signal.aborted)
  readonly aborted: Effect.Effect<boolean>;
  // the handler's own body completed its return path after the end reached it (the baseline's toolReturned), whether or
  // not the route still takes the value
  readonly returned: () => boolean;
  readonly tool: EffectTool;
}

// a controller tool that waits until the route ends its call, then returns {status: "unavailable", reason} with the reason
// name. only the wait is interruptible: an interruption ends the wait, and the handler still runs its return path, as the
// baseline promise handler returned after its abort; the route discards that value with the interrupted call
export const gateTool = (options: {readonly onEnter?: (aborted: boolean) => Effect.Effect<void>} = {}): GateTool => {
  const entered = Deferred.makeUnsafe<number>();
  const ended = Deferred.makeUnsafe<Ended>();
  let returned = false;
  return {
    entered: Deferred.await(entered),
    ended: Deferred.await(ended),
    aborted: Deferred.isDone(ended),
    returned: () => returned,
    tool: (_args, cancel) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      Deferred.doneUnsafe(entered, Exit.succeed(yield* Clock.currentTimeMillis));
      const aborted = yield* Deferred.isDone(ended);
      assert.equal(aborted, false);
      if (options.onEnter) yield* options.onEnter(aborted);
      // the deadline completes the soft cancel; the request's end or close() interrupts the wait
      const reason = yield* restore(cancel === undefined ? Effect.never : Deferred.await(cancel)).pipe(Effect.matchCauseEffect({
        onSuccess: () => Effect.succeed<Ended["reason"]>("TimeoutError"),
        onFailure: (cause) => Cause.hasInterruptsOnly(cause) ? Effect.succeed<Ended["reason"]>("AbortError") : Effect.failCause(cause),
      }));
      Deferred.doneUnsafe(ended, Exit.succeed({reason, at: yield* Clock.currentTimeMillis}));
      return {status: "unavailable", reason};
    }).pipe(Effect.tap(() => Effect.sync(() => {returned = true;})))),
  };
};
