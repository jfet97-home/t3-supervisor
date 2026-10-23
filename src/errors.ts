import { Cause, Data, Predicate } from "effect";

// the T3 read token could not be loaded; it carries no path, file content or cause, so rendering it leaks none
export class T3TokenUnavailable extends Data.TaggedError("T3TokenUnavailable") {
  // the fixed reason a failed start is reported with
  readonly reason = "t3_token_unavailable";
}

// a configuration value outside today's acceptance set; the message is the reason code alone, never the value
export class InvalidConfiguration extends Data.TaggedError("InvalidConfiguration")<{
  readonly reason: "invalid_helper_provider_instance_id" | "invalid_configuration";
}> {
  override readonly message: string = this.reason;
}

// the dashboard or the standalone workflow MCP listener could not listen; it carries no address, port or cause. The
// health listener's failure stays the server's ServeError
export class ListenerUnavailable extends Data.TaggedError("ListenerUnavailable")<{
  readonly reason: "dashboard_listener_unavailable" | "workflow_mcp_listener_unavailable";
}> {
  override readonly message: string = this.reason;
}

// the one-off interpretation cut-over refused to apply at start (src/interpretation-cutover.ts; deleted with it): the process
// exits with this reason and changes no row
export class InterpretationCutoverRefused extends Data.TaggedError("InterpretationCutoverRefused")<{
  readonly reason: "interpretation_cutover_blocked" | "interpretation_cutover_conflict";
}> {
  override readonly message: string = this.reason;
}

// the fixed reason a failed supervisor program is reported with; typed failures name their own, nothing else is rendered
export const failureReason = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  if (failure instanceof InvalidConfiguration || failure instanceof T3TokenUnavailable || failure instanceof ListenerUnavailable ||
    failure instanceof InterpretationCutoverRefused) return failure.reason;
  return Predicate.isTagged(failure, "ServeError") ? "health_listener_unavailable" : "supervisor_failed";
};
