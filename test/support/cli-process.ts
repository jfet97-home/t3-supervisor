import { createHash } from "node:crypto";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// the pure helpers and shared types of the process suites (the Effect process runner is g8-process.ts): repository paths, the
// child PATH, process-group liveness and token fingerprints for failure output

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const tsxLoader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StartOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin?: "ignore" | "pipe";
}

// whether any process of the group led by `pid` is still alive
export const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

export const nodePath = (): string => [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);

// a token is identified in failure output only by length and hash prefix
export const fingerprint = (value: string): string => `len=${value.length} sha256=${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

// the shape of a successful forge stdout without exposing the token itself
export const tokenLineShape = (stdout: string) => ({
  lines: stdout.split("\n").length - 1,
  endsWithNewline: stdout.endsWith("\n"),
  tokenLength: stdout.trimEnd().length,
  canonical: /^[A-Za-z0-9_-]{43}\n$/u.test(stdout),
});

export const leakedSecrets = (output: string, secrets: ReadonlyArray<string>): string[] =>
  secrets.filter((secret) => secret.length > 0 && output.includes(secret)).map(fingerprint);
