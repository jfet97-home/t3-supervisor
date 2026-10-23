import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Deferred, type Duration, Effect, Layer, type Scope } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";

// the loopback client side of the g11 dashboard and supervisor suites: small adapters over node's http and net clients
// (a raw request is the only way to send an exact Host header or an absolute-form target, which fetch cannot) and requests
// through effect's fetch client, each reading its whole body so no response stream outlives its request

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

export type RawRequest = { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer };

// the baseline helper's bound of each raw request (test/support/c3b-http.ts AbortSignal.timeout(5_000)), on the live clock
const rawRequestBound = "5 seconds";

/** A request with the exact path and headers, Host included; interrupting it destroys its socket. */
export const rawRequest = (port: number, options: RawRequest): Effect.Effect<RawResponse> => Effect.callback<RawResponse, Error>((resume) => {
  const payload = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  const request: ClientRequest = httpRequest({
    host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", agent: false,
    headers: { ...(payload ? { "Content-Length": String(payload.length) } : {}), ...options.headers },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("end", () => resume(Effect.succeed({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") })));
    response.once("error", (error) => resume(Effect.fail(error)));
  });
  request.once("error", (error) => resume(Effect.fail(error)));
  request.end(payload);
  return Effect.sync(() => request.destroy());
}).pipe(Effect.timeout(rawRequestBound), Effect.orDie);

export const jsonBody = (response: RawResponse): unknown => JSON.parse(response.body) as unknown;

/** An open request whose settlement the case awaits later: its response status once it ended, or its error code. */
export const openRequest = (port: number, options: RawRequest & { readonly settleOn?: "response" | "end" }) => Effect.sync(() => {
  const client = httpRequest({ host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET", agent: false, headers: options.headers ?? {} });
  // the listeners are attached before the request is sent, so no settlement is missed
  const settled = Deferred.makeUnsafe<string>();
  const settle = (outcome: string) => Deferred.doneUnsafe(settled, Effect.succeed(outcome));
  client.once("response", (response) => {
    response.resume();
    if (options.settleOn === "response") settle(`response ${response.statusCode}`);
    else response.once("end", () => settle(`response ${response.statusCode}`));
  });
  client.once("error", (error) => settle(`error ${(error as NodeJS.ErrnoException).code}`));
  client.end(options.body);
  return { client, settled: Deferred.await(settled) };
});

/** "refused" when nothing listens on the loopback port any more. */
export const portState = (port: number): Effect.Effect<"open" | "refused"> => Effect.callback<"open" | "refused", Error>((resume) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resume(Effect.succeed("open"));
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    socket.destroy();
    resume(error.code === "ECONNREFUSED" ? Effect.succeed("refused") : Effect.fail(error));
  });
  return Effect.sync(() => socket.destroy());
}).pipe(Effect.orDie);

/** A tcp connect attempt; refused means no listener accepts on the port. */
export const connectRefused = (port: number): Effect.Effect<boolean> => Effect.callback<boolean>((resume) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resume(Effect.succeed(false)); });
  socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); resume(Effect.succeed(error.code === "ECONNREFUSED")); });
  return Effect.sync(() => socket.destroy());
});

/** A port that was free a moment ago, for components that do not report the port they bound. */
export const freePort: Effect.Effect<number> = Effect.callback<number, Error>((resume) => {
  const server = createNetServer();
  server.once("error", (error) => resume(Effect.fail(error)));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    server.close((error) => resume(error ? Effect.fail(error) : Effect.succeed(address.port)));
  });
}).pipe(Effect.orDie);

/** Binding the port succeeds only when no listener holds it any more. */
export const portBindable = (port: number): Effect.Effect<boolean> => Effect.callback<boolean>((resume) => {
  const server = createNetServer();
  server.once("error", () => resume(Effect.succeed(false)));
  server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.succeed(true))));
});

/** A loopback tcp listener held for the scope, for a case whose port must be taken. */
export const blockedPort = Effect.acquireRelease(Effect.callback<ReturnType<typeof createNetServer>>((resume) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
}), (server) => Effect.callback<void>((resume) => {
  if (!server.listening) return resume(Effect.void);
  server.close(() => resume(Effect.void));
}));

/** Open file descriptors of this process whose target ends with the path, an absolute one through its resolved directory (linux /proc). */
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

export type Exchange = { status: number; headers: Record<string, string>; text: string };

export type ExchangeInit = { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; contentType?: string };

/** One request through effect's fetch client, its whole body read as text. */
export const exchange = (url: string, init: ExchangeInit = {}): Effect.Effect<Exchange> => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const base = init.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url);
  // a text body carries the request's content type, else fetch's default for a string body
  const contentType = init.contentType ?? init.headers?.["Content-Type"] ?? "text/plain;charset=UTF-8";
  const request = base.pipe(HttpClientRequest.setHeaders(init.headers ?? {}),
    (value) => init.body === undefined ? value : HttpClientRequest.setBody(value, HttpBody.text(init.body, contentType)));
  const response = yield* client.execute(request);
  return { status: response.status, headers: response.headers as Record<string, string>, text: yield* response.text };
}).pipe(Effect.orDie, Effect.provide(fetchClient));

/** The status and the parsed json body of a request. */
export const exchangeJson = (url: string, init: ExchangeInit = {}): Effect.Effect<[number, unknown]> =>
  Effect.map(exchange(url, init), (response) => [response.status, JSON.parse(response.text) as unknown]);

// the platform fetch, which the client runs over
const fetchClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));

/** An awaited event with an explicit deadline on the live clock: past it the case fails by the event's name. */
export const within = <A, E, R>(effect: Effect.Effect<A, E, R>, duration: Duration.Input, label: string): Effect.Effect<A, E, R> =>
  Effect.timeoutOrElse(effect, { duration, orElse: () => Effect.die(new Error(`timed out waiting for ${label}`)) });

/** A call's cancel that completes at its deadline on the live clock, as the baseline AbortSignal.timeout aborted. */
export const cancelAfter = (duration: Duration.Input): Effect.Effect<Deferred.Deferred<void>, never, Scope.Scope> => Effect.gen(function* () {
  const cancel = yield* Deferred.make<void>();
  yield* Effect.forkScoped(Effect.andThen(Effect.sleep(duration), Deferred.succeed(cancel, undefined)));
  return cancel;
});
