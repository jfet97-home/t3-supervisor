import { Deferred, Effect, Layer } from "effect";
import type { SupervisorTeamController } from "../../src/supervisor-team-controller.js";
import { WorkflowMcp } from "../../src/workflow-mcp.js";
import type { WorkflowCallCancel, WorkflowWriteController } from "../../src/workflow-write-controller.js";

// the workflow MCP route's promise tool fakes as the controller services it consumes (test harness only). The route reaches
// a call in two ways, and the fake's signal aborts as the baseline route aborted it: the 9 s deadline completes the call's soft
// cancel, which aborts the signal with the baseline deadline's TimeoutError, and the request's end or close() interrupts the
// call, which aborts it with an AbortError. A synchronous throw or a rejection is the call's defect

// one promise tool: its arguments and the signal of its call
export type PromiseTool = (args: unknown, signal: AbortSignal) => Promise<unknown>;

const deadlineAbort = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

const tool = (fake: PromiseTool | undefined) => (args: unknown, cancel?: WorkflowCallCancel) => Effect.scoped(Effect.gen(function* () {
  if (!fake) return yield* Effect.die(new Error("no such fake tool"));
  const controller = new AbortController();
  if (cancel !== undefined) yield* Effect.forkScoped(Effect.andThen(Deferred.await(cancel), Effect.sync(() => controller.abort(deadlineAbort()))));
  return yield* Effect.promise((interrupted) => {
    interrupted.addEventListener("abort", () => controller.abort(), {once: true});
    return fake(args, controller.signal);
  });
}));

// the write controller's four tools over their promise fakes; a tool without a fake dies when called
export const promiseWorkflowController = (fakes: {readTool?: PromiseTool; write?: PromiseTool; startSupervision?: PromiseTool; stopSupervision?: PromiseTool}):
  WorkflowWriteController["Service"] => ({
    readTool: tool(fakes.readTool),
    write: tool(fakes.write),
    startSupervision: tool(fakes.startSupervision),
    stopSupervision: tool(fakes.stopSupervision),
  }) as unknown as WorkflowWriteController["Service"];

// the team controller's two tools over their promise fakes
export const promiseTeamController = (fakes: {call?: PromiseTool; guide?: PromiseTool}): SupervisorTeamController["Service"] => ({
  call: tool(fakes.call),
  guide: tool(fakes.guide),
}) as unknown as SupervisorTeamController["Service"];

// the endpoint over the given controllers, as one layer; releasing it closes the endpoint
export const workflowMcpLayer = (controller: WorkflowWriteController["Service"], team?: SupervisorTeamController["Service"]): Layer.Layer<WorkflowMcp> =>
  Layer.effect(WorkflowMcp, WorkflowMcp.make(controller, team));
