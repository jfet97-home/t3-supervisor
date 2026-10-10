import WebSocket from "ws";
import type { JsonRecord } from "./types.js";

export type GuidanceReceipt = {
  outcome: "accepted" | "rejected" | "uncertain";
  messageId: string;
  sequence: number | null;
};
const record = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Uses the installed message.dispatch contract with a separate purpose credential. */
export const dispatchGuidance = (options: {
  baseUrl: string;
  token: string;
  threadId: string;
  runId: string;
  noticeId: string;
  text: string;
  beforeDispatch: () => boolean | Promise<boolean>;
  signal: AbortSignal;
}): Promise<GuidanceReceipt> =>
  new Promise((resolve) => {
    const messageId = `supervisor-notice:${options.noticeId}`;
    const url = new URL("/ws?orchestrationProtocol=2", options.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let sent = false;
    let finished = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${options.token}` },
        handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024,
      });
    } catch {
      resolve({ outcome: "rejected", messageId, sequence: null });
      return;
    }
    const finish = (
      outcome: GuidanceReceipt["outcome"],
      sequence: number | null = null,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      resolve({ outcome, messageId, sequence });
      try {
        socket.terminate();
      } catch {
        /* The outcome is already settled. */
      }
    };
    const abort = () => finish(sent ? "uncertain" : "rejected");
    const timer = setTimeout(abort, 20_000);
    options.signal.addEventListener("abort", abort, { once: true });
    socket.on("error", abort);
    socket.on("close", abort);
    socket.on("open", async () => {
      if (finished || options.signal.aborted) return abort();
      try {
        if (!(await options.beforeDispatch())) return finish("rejected");
      } catch {
        return finish("rejected");
      }
      if(finished || options.signal.aborted)return abort();
      sent = true;
      try {
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "guidance",
            tag: "orchestration.dispatchCommand",
            headers: [],
            payload: {
              type: "message.dispatch",
              commandId: `supervisor-guidance:${options.noticeId}`,
              messageId,
              threadId: options.threadId,
              text: options.text,
              attachments: [],
              creationSource: "server",
              dispatchMode: {
                type: "steer_active",
                targetRunId: options.runId,
              },
            },
          }),
          (error) => {
            if (error) finish("uncertain");
          },
        );
      } catch {
        finish("uncertain");
      }
    });
    socket.on("message", (data, binary) => {
      if (binary) return finish("uncertain");
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString()) as unknown;
      } catch {
        return finish("uncertain");
      }
      const envelopes: unknown[] = Array.isArray(parsed)
        ? parsed.flat(4)
        : [parsed];
      for (const envelope of envelopes) {
        if (!record(envelope)) return finish("uncertain");
        if (envelope._tag === "Ping") {
          try {
            socket.send(JSON.stringify({ _tag: "Pong" }));
          } catch {
            return finish("uncertain");
          }
          continue;
        }
        if (
          envelope.requestId !== "guidance" ||
          envelope._tag !== "Exit" ||
          !record(envelope.exit)
        )
          continue;
        // a failure after sending does not establish that no message was stored
        if (envelope.exit._tag === "Failure") return finish("uncertain");
        const result = envelope.exit.value;
        if (
          envelope.exit._tag === "Success" &&
          record(result) &&
          typeof result.sequence === "number" &&
          Number.isSafeInteger(result.sequence) &&
          result.sequence >= 0
        )
          return finish("accepted", result.sequence);
        return finish("uncertain");
      }
    });
    if (options.signal.aborted) abort();
  });
