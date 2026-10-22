import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "vitest";
import { after } from "./node-test.js";
import { startFakeT3, type FakeT3, type FakeT3Options } from "./cli-fake-t3.js";
import { freePort, nodePath, portState, startProcess, waitForHttp, type RunningProcess } from "./cli-process.js";

// a supervisor child process against a loopback fake T3, with private ports, token files and data directory

export interface SupervisorHarness {
  readonly home: string;
  readonly dataDirectory: string;
  readonly token: string;
  readonly tokenFile: string;
  readonly ports: { readonly health: number; readonly ui: number; readonly mcp: number };
  readonly fake: FakeT3;
  readonly env: NodeJS.ProcessEnv;
  start(command: string, args: ReadonlyArray<string>): RunningProcess;
}

export const supervisorHarness = async (t: TestContext, fakeOptions: Omit<FakeT3Options, "token"> = {}): Promise<SupervisorHarness> => {
  const home = await mkdtemp(join(tmpdir(), "cli-supervisor-"));
  const children: RunningProcess[] = [];
  const started: { fake?: FakeT3 } = {};
  // one hook so the order is fixed: children, then the fake T3, then the files
  after(t, async () => {
    try {
      for (const child of children) await child.dispose();
      await started.fake?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  const token = randomBytes(32).toString("base64url");
  const tokenFile = join(home, "t3-read-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const server = await startFakeT3({ token, ...fakeOptions });
  started.fake = server;
  const ports = { health: await freePort(), ui: await freePort(), mcp: await freePort() };
  const dataDirectory = join(home, "data");
  const absent = join(home, "absent-token");
  const env: NodeJS.ProcessEnv = {
    PATH: nodePath(), HOME: home, TMPDIR: home, XDG_STATE_HOME: join(home, "state"),
    DATA_DIRECTORY: dataDirectory, T3_URL: server.baseUrl, T3_TOKEN_FILE: tokenFile,
    HEALTH_PORT: String(ports.health), UI_PORT: String(ports.ui), UI_HOST: "127.0.0.1",
    WORKFLOW_MCP_BIND_HOST: "127.0.0.1", WORKFLOW_MCP_PORT: String(ports.mcp),
    T3_GUIDANCE_TOKEN_FILE: absent, T3_PROJECT_WRITE_TOKEN_FILE: absent, T3_PROJECT_COMMIT_TOKEN_FILE: absent, T3_GIT_PROBE_TOKEN_FILE: absent,
  };
  return {
    home, dataDirectory, token, tokenFile, ports, fake: server, env,
    start: (command, args) => {
      const child = startProcess(command, args, { env, cwd: home });
      children.push(child);
      return child;
    },
  };
};

const alive = (child: RunningProcess) => () => child.child.exitCode === null && child.child.signalCode === null;

export const readyTimeoutMs = 30_000;

// /health 200: activation, T3 connection, catalog and supervision all ready
export const waitUntilReady = (harness: SupervisorHarness, child: RunningProcess) =>
  waitForHttp(`http://127.0.0.1:${harness.ports.health}/health`, (status) => status === 200, readyTimeoutMs, alive(child));

// health served while the descriptor is refused: the catalog store is open and the descriptor retry is pending
export const waitUntilDescriptorRetry = async (harness: SupervisorHarness, child: RunningProcess) => {
  await harness.fake.until((traffic) => traffic.http.includes("GET /.well-known/t3/environment"), readyTimeoutMs, "a descriptor request");
  return waitForHttp(`http://127.0.0.1:${harness.ports.health}/health`, (status, body) =>
    status === 503 && (JSON.parse(body) as { lastErrorPhase?: unknown }).lastErrorPhase === "t3_authentication", readyTimeoutMs, alive(child));
};

export const listenerStates = async (harness: SupervisorHarness) => ({
  health: await portState(harness.ports.health),
  ui: await portState(harness.ports.ui),
  mcp: await portState(harness.ports.mcp),
});

// relative paths under the data directory, sorted
export const dataFiles = async (harness: SupervisorHarness): Promise<string[]> => {
  try {
    return (await readdir(harness.dataDirectory, { recursive: true })).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

// reopens every database read-write after exit and reports PRAGMA quick_check
export const quickChecks = (harness: SupervisorHarness, databases: ReadonlyArray<string>): Record<string, unknown> =>
  Object.fromEntries(databases.map((name) => {
    const database = new DatabaseSync(join(harness.dataDirectory, name));
    try {
      return [name, (database.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined)?.quick_check];
    } finally {
      database.close();
    }
  }));
