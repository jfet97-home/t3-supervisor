import { request } from "node:http";
import { connect, createServer } from "node:net";

// a port that was free a moment ago, for servers that do not expose their bound address
export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "0.0.0.0", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => port > 0 ? resolve(port) : reject(new Error("no port was allocated")));
  });
});

// settles every promise it creates, so a met deadline leaves nothing pending
export const withDeadline = async <A>(promise: Promise<A>, milliseconds: number, label: string): Promise<A> => {
  const expiry = Promise.withResolvers<"expired">();
  const timer = setTimeout(() => expiry.resolve("expired"), milliseconds);
  try {
    const winner = await Promise.race([promise.then((value) => ({ value })), expiry.promise]);
    if (winner === "expired") throw new Error(`${label}: no outcome within ${milliseconds} ms`);
    return winner.value;
  } finally {
    clearTimeout(timer);
    expiry.resolve("expired");
  }
};

export interface PlainResponse {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

// one request on its own connection (no keep-alive agent), so nothing outlives the response
export const httpGet = (port: number, path: string): Promise<PlainResponse> => withDeadline(new Promise((resolve, reject) => {
  const outgoing = request({ host: "127.0.0.1", port, path, method: "GET", agent: false }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", reject);
    response.once("end", () => resolve({
      status: response.statusCode ?? 0,
      contentType: response.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  outgoing.once("error", reject);
  outgoing.end();
}), 3_000, `GET ${path}`);

// the error code of a fresh tcp connection attempt, or null when something accepted it
export const connectionError = (port: number): Promise<string | null> => withDeadline(new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resolve(null);
  });
  socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
}), 3_000, `connect ${port}`);
