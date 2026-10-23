import { Schema } from "effect";
import { InterpretationAttempt, InterpretationAttemptId, InterpretationSourcePin } from "./interpretation-submission.js";

// the evidence an interpretation or a proposal rests on (plan 3.12 item 8). a new interpretation rests on its attempt's
// recorded tool submission; a later negotiated proposal, and an interpretation converted once by the cut-over (item 11),
// rest on a supervisor message. evidence is current only while its native item or message still matches
const Text = Schema.String.check(Schema.isNonEmpty());
const Hash = Schema.String.check(Schema.isNonEmpty());

export const InterpretationSubmissionEvidence = Schema.Struct({
  kind: Schema.Literal("interpretation_submission"),
  taskId: Text,
  attemptId: InterpretationAttemptId,
  itemId: Text,
  runId: Text,
  argumentsHash: Hash,
  sourcePin: InterpretationSourcePin,
  // the canonical digest of the submitted plan; null when the submission carries none (bare Start, not needed, no workflow)
  planDigest: Schema.NullOr(Hash),
});
export type InterpretationSubmissionEvidence = typeof InterpretationSubmissionEvidence.Type;

export const SupervisorMessageEvidence = Schema.Struct({
  kind: Schema.Literal("supervisor_message"),
  messageId: Text,
  runId: Text,
  runOrdinal: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  textHash: Hash,
  // set by the cut-over for a candidate-free interpretation: the plan digest and the source it interpreted
  planDigest: Schema.optional(Schema.NullOr(Hash)),
  sourcePin: Schema.optional(InterpretationSourcePin),
  // recorded by the cut-over when no valid native message exists; stale evidence is never current
  stale: Schema.optional(Schema.Boolean),
});
export type SupervisorMessageEvidence = typeof SupervisorMessageEvidence.Type;

export const InterpretationEvidence = Schema.Union([InterpretationSubmissionEvidence, SupervisorMessageEvidence]);
export type InterpretationEvidence = typeof InterpretationEvidence.Type;

// the two TaskRecord fields S6e adds (project-supervisor-store.ts): the pointer to the task's current attempt and, for a
// candidate-free interpretation, its evidence
export const TaskInterpretationFields = Schema.Struct({
  attempt: Schema.optional(InterpretationAttempt),
  interpretationEvidence: Schema.optional(InterpretationEvidence),
});
export type TaskInterpretationFields = typeof TaskInterpretationFields.Type;
