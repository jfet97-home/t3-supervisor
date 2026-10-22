import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { get } from "node:http";
import { connect, createServer } from "node:net";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// real child processes with explicit deadlines; every child leads its own process group so strays are observable

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const tsxLoader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly startedAt: number;
  stdout(): string;
  stderr(): string;
  // resolves once the process exited and its stdio closed
  closed(timeoutMs: number): Promise<ProcessResult>;
  // SIGKILL to the whole group if anything is still alive, then waits for close
  dispose(): Promise<void>;
}

const outputLimit = 1024 * 1024;

export interface StartOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin?: "ignore" | "pipe";
}

export const startProcess = (command: string, args: ReadonlyArray<string>, options: StartOptions): RunningProcess => {
  const child = spawn(command, args, { env: options.env, cwd: options.cwd, detached: true, stdio: [options.stdin ?? "ignore", "pipe", "pipe"] });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start ${command}`);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < outputLimit) stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < outputLimit) stderr += chunk; });
  let result: ProcessResult | undefined;
  const done = new Promise<ProcessResult>((resolve) => {
    child.once("close", (code, signal) => {
      result = { code, signal, stdout, stderr };
      resolve(result);
    });
  });
  const closed = (timeoutMs: number): Promise<ProcessResult> => {
    if (result !== undefined) return Promise.resolve(result);
    return new Promise<ProcessResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`process ${pid} did not exit within ${timeoutMs} ms`)), timeoutMs);
      void done.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
  return {
    child, pid, startedAt: performance.now(),
    stdout: () => stdout,
    stderr: () => stderr,
    closed,
    dispose: async () => {
      if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
      if (result === undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin?.destroy();
      await closed(10_000);
    },
  };
};

export const runProcess = async (command: string, args: ReadonlyArray<string>, options: StartOptions & { readonly timeoutMs: number }): Promise<ProcessResult> => {
  const running = startProcess(command, args, options);
  try {
    return await running.closed(options.timeoutMs);
  } finally {
    await running.dispose();
  }
};

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

export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => port > 0 ? resolve(port) : reject(new Error("no free port")));
  });
});

// "refused" when nothing listens on the loopback port any more
export const portState = (port: number): Promise<"open" | "refused"> => new Promise((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resolve("open");
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    socket.destroy();
    if (error.code === "ECONNREFUSED") resolve("refused");
    else reject(error);
  });
});

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

// one request on a fresh connection that is closed afterwards, so no pooled socket outlives the test
export const httpGet = (url: string, timeoutMs: number): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const request = get(url, { agent: false, headers: { connection: "close" }, timeout: timeoutMs }, (response) => {
    let body = "";
    response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
    response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
    response.once("error", reject);
  });
  request.once("timeout", () => request.destroy(new Error(`${url} timed out`)));
  request.once("error", reject);
});

// polls a child's http endpoint (no event exists for its readiness) until `accept` holds or the deadline passes
export const waitForHttp = async (url: string, accept: (status: number, body: string) => boolean, timeoutMs: number,
  alive: () => boolean): Promise<{ status: number; body: string }> => {
  const deadline = performance.now() + timeoutMs;
  let last = "no response";
  while (performance.now() < deadline) {
    if (!alive()) throw new Error(`process exited while waiting for ${url} (${last})`);
    try {
      const response = await httpGet(url, 2_000);
      last = `HTTP ${response.status}`;
      if (accept(response.status, response.body)) return response;
    } catch {
      last = "connection failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not reach the expected state within ${timeoutMs} ms (${last})`);
};
