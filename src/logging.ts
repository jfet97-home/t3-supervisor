import { Clock, Console, Effect, Logger, References } from "effect";
import { redact } from "./credential-redaction.js";

// a sanitized classification: scalar fields such as a phase, a status, a size or an id, never a cause or a native body
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

const isField = (value: unknown): value is LogFields[string] =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

// today's one-line shape {"time","event",...fields}; string values pass the credential redaction
const eventLine = (date: Date, event: string, fields: LogFields): string => {
  const sanitized: Record<string, LogFields[string]> = {};
  for (const [key, value] of Object.entries(fields)) sanitized[key] = typeof value === "string" ? redact(value) : value;
  return JSON.stringify({ time: date.toISOString(), event: redact(event), ...sanitized });
};

// writes one event line through the current Console, stamped by the current Clock; it is no Effect log record, so the
// line does not depend on the installed loggers
export const logEvent = (event: string, fields: LogFields = {}): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Console.log(eventLine(new Date(now), event, fields)));

// the process logger for Effect log records, in the same shape: the message text is the event (the level when there is
// none) and the scalar annotations are the fields; causes, spans and structured values are never written
export const jsonLogger: Logger.Logger<unknown, void> = Logger.withConsoleLog(Logger.make(({ date, fiber, logLevel, message }) => {
  const text = (Array.isArray(message) ? message : [message]).filter((part) => typeof part === "string").join(" ");
  const fields: Record<string, LogFields[string]> = {};
  for (const [key, value] of Object.entries(fiber.getRef(References.CurrentLogAnnotations))) if (isField(value)) fields[key] = value;
  return eventLine(date, text || logLevel.toLowerCase(), fields);
}));
