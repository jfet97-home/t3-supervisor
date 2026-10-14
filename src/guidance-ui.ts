import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpRouter, HttpServer } from "effect/http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { SupervisorApi, UiError } from "./guidance-contract.js";
import type { GuidanceRuntime } from "./guidance.js";
import type { SupervisorConfig } from "./types.js";
import type { ProjectDefinitionLoader } from "./project-definitions.js";
import type { ProjectRuleEditor } from "./project-rule-editor.js";
import type { ProjectSupervisor } from "./project-supervisor.js";

export type WorkflowMcpEndpoint = {
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
};

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
class BodyLimitError extends Error {}
const body = async (request: IncomingMessage, limit = 64_000): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({destroyOnReturn: false})) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.length;
    if (size > limit) {request.resume();throw new BodyLimitError("body_limit");}
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const startGuidanceUi = async (
  config: SupervisorConfig,
  runtime: GuidanceRuntime,
  definitions?: ProjectDefinitionLoader,
  editor?: ProjectRuleEditor,
  supervision?: ProjectSupervisor,
  workflows?: WorkflowMcpEndpoint,
) => {
  const requireLegacy = () => {if (runtime.retired !== false) throw new Error("Legacy guidance rules are retired. Edit project rules in Projects.");};
  const legacyMessage = (fallback: string) => runtime.retired !== false ? "Legacy guidance rules are retired. Edit project rules in Projects." : fallback;
  const handlers = HttpApiBuilder.group(SupervisorApi, "guidance", (h) =>
    h.handleAll({
      snapshot: () => Effect.promise(() => runtime.snapshot()),
      supervisionControl: ({query}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.control(query.projectId ?? null, signal);},
        catch: () => new UiError({message: "Supervision control is unavailable."}),
      }),
      saveSupervisionControl: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.saveControl(payload, signal);},
        catch: () => new UiError({message: "The enable/disable outcome could not be confirmed. Reload before trying again."}),
      }),
      supervisionSetupOptions: ({query}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.setupOptions(query.projectId, signal);},
        catch: () => new UiError({message: "Registered checkout options could not be loaded."}),
      }),
      setupSupervision: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.setup(payload, signal);},
        catch: () => new UiError({message: "The setup outcome could not be confirmed. Inspect the selected checkout before retrying."}),
      }),
      globalDefinitionsControl: () => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.globalDefinitionsControl(signal);},
        catch: () => new UiError({message: "Global rules control is unavailable."}),
      }),
      saveGlobalDefinitionsControl: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.saveGlobalDefinitionsControl(payload, signal);},
        catch: () => new UiError({message: "The global rules setup outcome could not be confirmed. Inspect ~/.t3-supervisor before retrying."}),
      }),
      projectSupervisor: ({query}) => Effect.tryPromise({
        try: signal => {
          if (!supervision) throw new Error("supervision_unavailable");return supervision.snapshot(query.projectId, signal, query.mainThreadId ?? null);
        }, catch: () => new UiError({message: "Project supervision is unavailable. Check the T3 connection and registered project."}),
      }),
      saveProjectSupervisor: ({payload}) => Effect.tryPromise({
        try: signal => {
          if (!supervision) throw new Error("supervision_unavailable");return supervision.save(payload, signal);
        }, catch: () => new UiError({message: "Supervisor settings could not be confirmed. Refresh and inspect the current selection before saving again."}),
      }),
      retryProjectSupervisor: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.retry(payload, signal);},
        catch: () => new UiError({message: "Native access retry could not be confirmed. Refresh to inspect the retained state."}),
      }),
      projectDefinitions: ({query}) => Effect.tryPromise({
        try: (signal) => {
          if (!definitions) throw new Error("Project definition access is not configured.");
          return definitions.load(query.projectId, query.threadId ?? null, signal).then(result => ({...result, editingAvailable: Boolean(editor)}));
        },
        catch: () => new UiError({message: "Project definition access is unavailable."}),
      }),
      saveProjectRules: ({payload}) => Effect.tryPromise({
        try: signal => editor ? editor.save(payload, signal) : Promise.resolve({status: "permission_required" as const, message: "Project editing needs a dedicated filesystem:read/filesystem:write credential through deployment setup.", definitions: null}),
        catch: () => new UiError({message: "The save outcome could not be confirmed. Refresh and inspect rules.yaml before retrying."}),
      }),
      saveRule: ({ payload }) =>
        Effect.try({
          try: () => {requireLegacy();return runtime.store.saveRule(payload);},
          catch: () =>
            new UiError({
              message:
                "Legacy guidance rules are retired, or the rule changed. Edit project rules in Projects.",
            }),
        }),
      settings: ({ payload }) =>
        Effect.try({
          try: () => {
            requireLegacy();
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
                legacyMessage("Settings invalid, T3 version changed or another tab saved first. Reload first."),
            }),
        }),
      threadPolicy: ({ payload }) => Effect.tryPromise({
        try: async () => {
          const policy = runtime.config.threadPolicy;
          if (!policy) throw new Error("Chat settings unavailable.");
          if (payload.interactiveThreadId !== null && payload.interactiveThreadId !== policy.get().interactiveThreadId) {
            const snapshot = await runtime.snapshot();
            if (!snapshot.threads.some(t => t.id === payload.interactiveThreadId && t.available)) throw new Error("Choose an available ordinary chat.");
          }
          return policy.save(payload);
        },
        catch: (cause) => new UiError({ message: cause instanceof Error ? cause.message : "Chat settings invalid. Reload first." }),
      }),
      mute: ({ payload }) =>
        Effect.try({
          try: () =>
            (requireLegacy(), runtime.store.mute(
              payload.ruleId,
              payload.scopeId,
              payload.muted,
              payload.expectedGeneration,
            )),
          catch: () =>
            new UiError({
              message: legacyMessage("Cannot change mute: reload the global rule first."),
            }),
        }),
      classify: ({ payload }) =>
        Effect.tryPromise({
          try: async () => {
            requireLegacy();
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
              message: legacyMessage("Project unavailable or settings changed. Reload first."),
            }),
        }),
      action: ({ payload }) =>
        Effect.try({
          try: () => {
            requireLegacy();
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
                legacyMessage("Cannot reset: the operation is unavailable, still in flight or requires accepting uncertainty."),
            }),
        }),
      preview: ({ payload }) =>
        Effect.tryPromise({
          try: (signal) => {
            requireLegacy();
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
                legacyMessage("Preview unavailable. Check the evidence, model connection and monitoring budget."),
            }),
        }),
    }),
  );
  const routes = HttpApiBuilder.layer(SupervisorApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const csrf = randomBytes(32).toString("base64url");
  const activeRequests = new Set<AbortController>();
  const assets = resolve(config.uiAssetsDirectory ?? "ui-dist");
  await rm(join(config.dataDirectory, "ui-login-code"), { force: true });
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : config.uiPort;
      const origin = `http://127.0.0.1:${port}`;
      const url = new URL(request.url ?? "/", origin);
      const navigation =
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html") &&
        request.headers["sec-fetch-mode"] === "navigate" &&
        request.headers["sec-fetch-dest"] === "document" &&
        request.headers["sec-fetch-user"] === "?1";
      const headers: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        Vary: "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Fetch-User",
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
        (request.headers["sec-fetch-site"] === "cross-site" && !navigation)
      )
        return reject(403, "Open the supervisor through its loopback address.");
      if (url.pathname === "/mcp/workflows") {
        if (!workflows) return reject(404, "Workflow MCP is unavailable.");
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        await workflows.handle(request, response);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (
          request.method !== "GET" &&
          (request.headers.origin !== origin ||
            typeof request.headers["x-csrf-token"] !== "string" ||
            !equal(request.headers["x-csrf-token"], csrf))
        )
          return reject(
            403,
            "Refresh the local dashboard before changing settings.",
          );
        if (
          request.method !== "GET" &&
          !request.headers["content-type"]?.startsWith("application/json")
        )
          return reject(415, "Use JSON for supervisor mutations.");
        if (url.pathname === "/api/csrf" && request.method === "GET") {
          response.writeHead(200, {
            ...headers,
            "Content-Type": "application/json",
            "Set-Cookie": "supervisor_owner=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
          });
          response.end(JSON.stringify({ csrf }));
          return;
        }
        const input =
          request.method === "GET" ? undefined : await body(request, url.pathname === "/api/guidance/project-rules" ? 256 * 1024 : 64_000);
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
    })().catch(error => {
      if (!response.headersSent)
        response.writeHead(error instanceof BodyLimitError ? 413 : 500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      response.end(
        JSON.stringify({ message: error instanceof BodyLimitError ? "The request payload is too large. Reduce its size before retrying." : "Supervisor operation unavailable." }),
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
      await workflows?.close();
      await new Promise<void>((res) => {server.close(() => res());server.closeAllConnections();});
      await web.dispose();
    },
  };
};
