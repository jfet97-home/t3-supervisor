import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { Reporter, Vitest } from "vitest/node";

// reads the internal `vitest.state.leakSet` of the pinned vitest 5.0.5: `{ stack, type, filename, projectName }` (dist/chunks/index.CoUIxZd4.js:86-91)

export interface LeakAllowance {
  // async resource type as reported by vitest, for example "Timeout"
  readonly kind: string;
  // first repository frame that created the resource, "path:line:column" relative to the root
  readonly source: string;
  // test file that was running, relative to the root
  readonly file: string;
  readonly maxCount: number;
  // slice whose change removes the leak
  readonly removedIn: string;
  readonly reason: string;
}

// filled from the measured s0 run; s8 requires it to be empty
export const leakAllowlist: ReadonlyArray<LeakAllowance> = [];

export interface LeakVerdict {
  readonly failed: boolean;
  readonly lines: ReadonlyArray<string>;
}

interface LeakRecord {
  readonly kind: string;
  readonly source: string;
  readonly file: string;
}

const unknownLocation = "<unknown>";

const failClosed = (reason: string): LeakVerdict => ({ failed: true, lines: [`leak-gate: ${reason}; failing closed`] });

const repositoryPath = (path: string, root: string): string | undefined => {
  const absolute = path.startsWith("file://") ? fileURLToPath(path) : path;
  if (!isAbsolute(absolute)) return undefined;
  const local = relative(root, absolute);
  if (local === "" || local.startsWith("..") || isAbsolute(local)) return undefined;
  const parts = local.split(sep);
  return parts.includes("node_modules") ? undefined : parts.join("/");
};

const stackFrame = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;

const creatingSource = (stack: string, root: string): string => {
  for (const line of stack.split("\n")) {
    const match = stackFrame.exec(line);
    if (match === null) continue;
    const [, path = "", row, column] = match;
    const local = repositoryPath(path, root);
    if (local !== undefined) return `${local}:${row}:${column}`;
  }
  return unknownLocation;
};

const leakRecord = (leak: unknown, root: string): LeakRecord => {
  const fields = typeof leak === "object" && leak !== null ? leak as Record<string, unknown> : {};
  const { type, stack, filename } = fields;
  return {
    kind: typeof type === "string" ? type : unknownLocation,
    source: typeof stack === "string" ? creatingSource(stack, root) : unknownLocation,
    file: typeof filename === "string" ? repositoryPath(filename, root) ?? filename : unknownLocation,
  };
};

const validAllowance = (allowance: LeakAllowance): boolean =>
  [allowance.kind, allowance.source, allowance.file, allowance.removedIn, allowance.reason].every((field) => field.trim() !== "")
  && Number.isSafeInteger(allowance.maxCount) && allowance.maxCount > 0;

export const evaluateLeaks = (
  state: unknown,
  detectAsyncLeaks: unknown,
  root: string,
  allowlist: ReadonlyArray<LeakAllowance>,
): LeakVerdict => {
  if (detectAsyncLeaks !== true) return failClosed("detectAsyncLeaks is not enabled");
  const leakSet = typeof state === "object" && state !== null ? (state as { readonly leakSet?: unknown }).leakSet : undefined;
  if (!(leakSet instanceof Set)) return failClosed("vitest state.leakSet is missing or not a Set");
  const invalid = allowlist.find((allowance) => !validAllowance(allowance));
  if (invalid !== undefined) return failClosed(`invalid allowlist entry for ${invalid.kind} ${invalid.source} in ${invalid.file}`);
  const groups = new Map<string, { readonly record: LeakRecord; count: number }>();
  for (const leak of leakSet) {
    const record = leakRecord(leak, root);
    const key = JSON.stringify([record.kind, record.source, record.file]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { record, count: 1 });
    else group.count += 1;
  }
  let allowlisted = 0;
  const unexpected: string[] = [];
  for (const { record, count } of groups.values()) {
    const allowance = allowlist.find((entry) =>
      entry.kind === record.kind && entry.source === record.source && entry.file === record.file);
    const covered = Math.min(count, allowance?.maxCount ?? 0);
    allowlisted += covered;
    const excess = count - covered;
    if (excess > 0) unexpected.push(`leak-gate: unexpected ${record.kind} from ${record.source} in ${record.file}${excess > 1 ? ` (${excess}x)` : ""}`);
  }
  const unexpectedCount = leakSet.size - allowlisted;
  return {
    failed: unexpectedCount > 0,
    lines: [`leak-gate: ${leakSet.size} leak(s), ${allowlisted} allowlisted, ${unexpectedCount} unexpected`, ...unexpected],
  };
};

export interface LeakGateOptions {
  readonly allowlist?: ReadonlyArray<LeakAllowance>;
  readonly write?: (line: string) => void;
  readonly fail?: () => void;
}

export class LeakGate implements Reporter {
  readonly #allowlist: ReadonlyArray<LeakAllowance>;
  readonly #write: (line: string) => void;
  readonly #fail: () => void;
  #vitest: Vitest | undefined;

  constructor(options: LeakGateOptions = {}) {
    this.#allowlist = options.allowlist ?? leakAllowlist;
    this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.#fail = options.fail ?? (() => { process.exitCode = 1; });
  }

  onInit(vitest: Vitest): void {
    this.#vitest = vitest;
  }

  onTestRunEnd(): void {
    const vitest = this.#vitest;
    const verdict = vitest === undefined
      ? failClosed("the reporter was not initialised")
      : evaluateLeaks(vitest.state, vitest.config.detectAsyncLeaks, vitest.config.root, this.#allowlist);
    for (const line of verdict.lines) this.#write(line);
    if (verdict.failed) this.#fail();
  }
}

// appended after config resolution so a cli `--reporter` override cannot drop the gate
export const leakGate = (options: LeakGateOptions = {}): Plugin => ({
  name: "t3-supervisor:leak-gate",
  configureVitest({ vitest }) {
    if (!vitest.config.reporters.some((reporter) => reporter instanceof LeakGate)) vitest.config.reporters.push(new LeakGate(options));
  },
});
