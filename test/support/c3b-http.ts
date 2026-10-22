import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { TestContext } from "vitest";
import { forgeDashboardToken } from "./service-auth-harness.js";
import { after } from "./node-test.js";

// loopback helpers shared by the c3b characterization suites

const stacks = new WeakMap<TestContext, Array<() => unknown>>();

// registers a cleanup that runs last-registered-first, so a resource closes before the directory it lives in is removed
export const defer = (t: TestContext, cleanup: () => unknown): void => {
  let stack = stacks.get(t);
  if (!stack) {
    const created: Array<() => unknown> = [];
    stack = created;
    stacks.set(t, created);
    after(t, async () => {
      let failure: unknown;
      for (const hook of created.reverse()) {
        try { await hook(); } catch (error) { failure ??= error; }
      }
      if (failure !== undefined) throw failure;
    });
  }
  stack.push(cleanup);
};

export const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

// an explicit deadline for an awaited event; the timer is always cleared
export const within = <A>(promise: Promise<A>, milliseconds: number, label: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });

// one loop turn: every pending microtask has run before it resolves
export const loopTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// a raw request with exact path and headers, including Host, which fetch cannot set
export const rawRequest = (port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    const request = httpRequest({
      host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", signal: AbortSignal.timeout(5_000), agent: false,
      headers: { ...(payload ? { "Content-Length": String(payload.length) } : {}), ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(payload);
  });

export const jsonBody = (response: RawResponse): unknown => JSON.parse(response.body) as unknown;

// a port that was free a moment ago, for components that do not report the port they bound
export const freePort = async (): Promise<number> => {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
};

// binding the port succeeds only when no listener holds it any more
export const portBindable = async (port: number): Promise<boolean> => {
  const server = createNetServer();
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (bound) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return bound;
};

// a tcp connect attempt; refused means no listener accepts on the port
export const connectRefused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code === "ECONNREFUSED"); });
  });

// open file descriptors of this process whose target ends with the path, an absolute one through its resolved directory (linux /proc)
export const openDescriptors = (path: string): number => {
  const suffix = isAbsolute(path) && existsSync(dirname(path)) ? join(realpathSync(dirname(path)), basename(path)) : path;
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    let target: string;
    try { target = readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
    if (target.endsWith(suffix)) count++;
  }
  return count;
};

export const signIn = async (origin: string, directory: string): Promise<string> => {
  const token = (await forgeDashboardToken(directory)).token;
  const response = await fetch(origin + "/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { session?: unknown };
  assert.equal(typeof payload.session, "string");
  return payload.session as string;
};

export const readCsrf = async (origin: string, session: string): Promise<string> => {
  const response = await fetch(origin + "/api/csrf", { headers: { "x-supervisor-session": session } });
  assert.equal(response.status, 200);
  return (await response.json() as { csrf: string }).csrf;
};
