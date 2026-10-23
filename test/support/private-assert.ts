import { fingerprint } from "./cli-process.js";

// a run of 32 or more url-safe base64 characters: the shape of every service token, grant and session value
const tokenShaped = /[A-Za-z0-9_-]{32,}/gu;

// the text with every known secret replaced by its fingerprint and any other token-shaped run masked
export const redact = (text: string, secrets: ReadonlyArray<string>): string => {
  let result = text;
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join(`<secret ${fingerprint(secret)}>`);
  return result.replace(tokenShaped, (run) => `<token-shaped ${fingerprint(run)}>`);
};

const rethrow = (label: string, secrets: ReadonlyArray<string>, error: unknown): never => {
  throw new Error(`${label}: ${redact(error instanceof Error ? error.message : String(error), secrets)}`);
};

// runs a check and, when it fails, throws a fresh error carrying only the label and the redacted message: no actual,
// expected, cause or diff, so a private value inside the compared data never reaches the test report
export const privately = <A>(label: string, secrets: ReadonlyArray<string>, check: () => A): A => {
  try {
    return check();
  } catch (error) {
    return rethrow(label, secrets, error);
  }
};

// a failed child process reported by exit status and output sizes only: its captured output may hold a token
export const childFailure = (label: string, error: unknown): Error => {
  const failed = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
  const size = (output: unknown) => typeof output === "string" ? output.length : 0;
  return new Error(`${label} failed (code ${String(failed.code)}, signal ${String(failed.signal)}, stdout ${size(failed.stdout)} bytes, `
    + `stderr ${size(failed.stderr)} bytes)`);
};
