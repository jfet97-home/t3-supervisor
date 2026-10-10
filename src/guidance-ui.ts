import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter, HttpServer } from "effect/http";
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { SupervisorApi, UiError } from "./guidance-contract.js";
import type { GuidanceRuntime } from "./guidance.js";
import type { SupervisorConfig } from "./types.js";

export const createUiLoginCode = async (directory: string): Promise<string> => {
  const code = randomBytes(24).toString("base64url");
  await writeFile(join(directory, "ui-login-code"), code, { mode: 0o600 });
  return code;
};
const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const body = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.length;
    if (size > 64_000) throw new Error("body_limit");
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const startGuidanceUi = async (
  config: SupervisorConfig,
  runtime: GuidanceRuntime,
) => {
  const handlers = HttpApiBuilder.group(SupervisorApi, "guidance", (h) =>
    h.handleAll({
      snapshot: () => Effect.promise(() => runtime.snapshot()),
      saveRule: ({ payload }) =>
        Effect.try({
          try: () => runtime.store.saveRule(payload),
          catch: () =>
            new UiError({
              message:
                "Rule invalid or changed in another tab. Reload and check its fields.",
            }),
        }),
      settings: ({ payload }) =>
        Effect.try({
          try: () => {
            const previous=runtime.store.settings();
            if (
              payload.allowFollowupRace &&
              (!previous.allowFollowupRace || payload.verifiedServerVersion!==previous.verifiedServerVersion) &&
              (!runtime.descriptor ||
                payload.verifiedServerVersion !==
                  runtime.descriptor.serverVersion)
            )
              throw new Error("version_changed");
            return runtime.store.saveSettings(payload);
          },
          catch: () =>
            new UiError({
              message:
                "Settings invalid, T3 version changed or another tab saved first. Reload first.",
            }),
        }),
      mute: ({ payload }) =>
        Effect.try({
          try: () =>
            runtime.store.mute(
              payload.ruleId,
              payload.scopeId,
              payload.muted,
              payload.expectedGeneration,
            ),
          catch: () =>
            new UiError({
              message: "Cannot change mute: reload the global rule first.",
            }),
        }),
      classify: ({ payload }) =>
        Effect.tryPromise({
          try: async () => {
            const snapshot = await runtime.snapshot();
            if (
              !snapshot.projects.some(
                (p) => p.id === payload.projectId && p.available,
              )
            )
              throw new Error("project_missing");
            runtime.store.classify(
              payload.projectId,
              payload.classification,
              payload.expectedGeneration,
            );
          },
          catch: () =>
            new UiError({
              message: "Project unavailable or settings changed. Reload first.",
            }),
        }),
      action: ({ payload }) =>
        Effect.try({
          try: () => {
            const activity = runtime.store
              .activities()
              .find((a) => a.id === payload.id);
            if (!activity?.threadId || !activity.ruleId)
              throw new Error("activity_missing");
            if (payload.action !== "feedback_wrong") {
              if(activity.episodeEpoch===undefined || payload.expectedEpoch!==activity.episodeEpoch || payload.noticeId!==(activity.noticeId??null))throw new Error("activity_identity_changed");
              runtime.store.reset(
                activity.threadId,
                activity.ruleId,
                payload.action === "accept_uncertainty",
                payload.expectedEpoch,
                payload.noticeId,
              );
            }
            runtime.store.record({
              kind: "owner_action",
              threadId: activity.threadId,
              ruleId: activity.ruleId,
              runId: activity.runId,
              state: payload.action,
              reason: "owner_requested",
              detail: null,
            });
          },
          catch: () =>
            new UiError({
              message:
                "Cannot reset: the operation is unavailable, still in flight or requires accepting uncertainty.",
            }),
        }),
      preview: ({ payload }) =>
        Effect.tryPromise({
          try: (signal) => {
            if (
              !payload.condition.trim() ||
              !payload.evidence.trim() ||
              payload.condition.length > 8000 ||
              payload.evidence.length > 20_000
            )
              throw new Error("preview_invalid");
            return runtime.model.decide(
              payload.condition,
              payload.evidence,
              ["preview"],
              AbortSignal.any([signal,AbortSignal.timeout(120_000)]),
            );
          },
          catch: () =>
            new UiError({
              message:
                "Preview unavailable. Check the evidence, model connection and monitoring budget.",
            }),
        }),
    }),
  );
  const routes = HttpApiBuilder.layer(SupervisorApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const activeRequests = new Set<AbortController>();
  const loginAttempts = new Map<string, { at: number; count: number }>();
  const assets = resolve(config.uiAssetsDirectory ?? "ui-dist");
  const codePath = join(config.dataDirectory, "ui-login-code");
  await createUiLoginCode(config.dataDirectory);
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : config.uiPort;
      const origin = `http://127.0.0.1:${port}`;
      const headers: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
      };
      const reject = (status: number, message: string) => {
        response.writeHead(status, {
          ...headers,
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify({ message }));
      };
      if (
        request.headers.host !== `127.0.0.1:${port}` ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        return reject(403, "Open the supervisor through its loopback address.");
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/api/login") {
        if (
          request.method !== "POST" ||
          request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json"
        )
          return reject(403, "Use the owner login form.");
        const key = request.socket.remoteAddress ?? "local";
        const prior = loginAttempts.get(key);
        const attempt =
          prior && Date.now() - prior.at < 60_000
            ? prior
            : { at: Date.now(), count: 0 };
        attempt.count++;
        loginAttempts.set(key, attempt);
        if (attempt.count > 10)
          return reject(429, "Wait a minute before trying again.");
        const parsed: unknown = JSON.parse(await body(request));
        const input =
          typeof parsed === "object" && parsed !== null && "code" in parsed
            ? parsed.code
            : null;
        let code: string;
        let modified: number;
        try {
          code = (await readFile(codePath, "utf8")).trim();
          modified = (await stat(codePath)).mtimeMs;
        } catch {
          return reject(401, "Generate a new local login code.");
        }
        if (
          typeof input !== "string" ||
          Date.now() - modified > 15 * 60_000 ||
          !equal(input, code)
        )
          return reject(401, "Code invalid or expired.");
        const id = randomBytes(32).toString("base64url");
        const csrf = randomBytes(24).toString("base64url");
        if (sessions.size >= 20) sessions.clear();
        sessions.set(id, { csrf, expires: Date.now() + 8 * 3600_000 });
        await rm(codePath, { force: true });
        response.writeHead(200, {
          ...headers,
          "Content-Type": "application/json",
          "Set-Cookie": `supervisor_owner=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
        });
        response.end(JSON.stringify({ csrf }));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const id = request.headers.cookie
          ?.split(";")
          .map((p) => p.trim())
          .find((p) => p.startsWith("supervisor_owner="))
          ?.slice("supervisor_owner=".length);
        const session = id ? sessions.get(id) : undefined;
        if (!session || session.expires < Date.now()) {
          if (id) sessions.delete(id);
          return reject(401, "Owner login required.");
        }
        if (
          request.method !== "GET" &&
          (request.headers.origin !== origin ||
            request.headers["x-csrf-token"] !== session.csrf)
        )
          return reject(
            403,
            "Refresh the owner session before changing settings.",
          );
        if (
          request.method !== "GET" &&
          url.pathname !== "/api/logout" &&
          !request.headers["content-type"]?.startsWith("application/json")
        )
          return reject(415, "Use JSON for supervisor mutations.");
        if (url.pathname === "/api/session" && request.method === "GET") {
          response.writeHead(200, {
            ...headers,
            "Content-Type": "application/json",
          });
          response.end(JSON.stringify({ csrf: session.csrf }));
          return;
        }
        if (url.pathname === "/api/logout" && request.method === "POST") {
          sessions.delete(id!);
          response
            .writeHead(204, {
              ...headers,
              "Set-Cookie":
                "supervisor_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
            })
            .end();
          return;
        }
        const input =
          request.method === "GET" ? undefined : await body(request);
        const init: RequestInit = {
          method: request.method ?? "GET",
          headers: { "Content-Type": "application/json" },
        };
        const controller=new AbortController();
        activeRequests.add(controller);
        const abort=()=>{if(!response.writableEnded)controller.abort();};
        response.once("close",abort);
        init.signal=controller.signal;
        if (input !== undefined) init.body = input;
        let result:Response;
        try { result = await web.handler(new Request(url, init)); }
        finally { activeRequests.delete(controller);response.off("close",abort); }
        const resultHeaders: Record<string, string> = { ...headers };
        result.headers.forEach((value, key) => {
          resultHeaders[key] = value;
        });
        response.writeHead(result.status, resultHeaders);
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (request.method !== "GET") return reject(405, "Method not allowed.");
      const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const path = resolve(assets, relative);
      if (!path.startsWith(assets + sep)) return reject(404, "Not found.");
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch {
        return reject(404, "Not found.");
      }
      const nonce = randomBytes(20).toString("base64url");
      headers["Content-Security-Policy"] =
        `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
      const type: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      headers["Content-Type"] =
        type[extname(path)] ?? "application/octet-stream";
      if (extname(path) === ".html")
        bytes = Buffer.from(
          bytes
            .toString("utf8")
            .replace(/<script\b/gu, `<script nonce="${nonce}"`),
        );
      response.writeHead(200, headers);
      response.end(bytes);
    })().catch(() => {
      if (!response.headersSent)
        response.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      response.end(
        JSON.stringify({ message: "Supervisor operation unavailable." }),
      );
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(config.uiPort ?? 9008, config.uiHost ?? "127.0.0.1", res);
  });
  return {
    server,
    close: async () => {
      for(const controller of activeRequests)controller.abort();
      await new Promise<void>((res) => {server.close(() => res());server.closeAllConnections();});
      await web.dispose();
      sessions.clear();
    },
  };
};
