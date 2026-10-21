import { Context, Effect, Layer } from "effect";
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
import type { ProjectConfigEditor } from "./project-config-editor.js";
import type { ProjectSupervisor } from "./project-supervisor.js";
import type { WorkflowWriteController } from "./workflow-write-controller.js";
import { parseWorkflowProgressPageQuery, readWorkflowProgressPage } from "./workflow-progress.js";
import { createServiceAuth } from "./service-auth.js";
import { overviewPage } from "./dashboard-overview.js";

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
  editor?: ProjectConfigEditor,
  supervision?: ProjectSupervisor,
  workflows?: WorkflowMcpEndpoint,
  workflowReader?: WorkflowWriteController,
) => {
  const mcpHosts = config.workflowMcpHosts ?? [];
  if (mcpHosts.some(host => !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):[0-9]{1,5}$/u.test(host)))
    throw new Error("Workflow MCP hosts must be exact host:port values.");
  await rm(join(config.dataDirectory, "ui-login-code"), { force: true });
  const handlers = HttpApiBuilder.group(SupervisorApi, "guidance", (h) =>
    h.handleAll({
      snapshot: () => Effect.promise(() => runtime.snapshot()),
      dashboardOverview: ({query}) => Effect.tryPromise({
        try: () => {if (!supervision) throw new Error("supervision_unavailable");return supervision.overview(overviewPage(query));},
        catch: () => new UiError({message: "The work overview is unavailable. Refresh to try again."}),
      }),
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
      workflowProgress: ({query}) => Effect.tryPromise({
        try: signal => {
          if (!supervision || !workflowReader) throw new Error("workflow_progress_unavailable");
          const parsed = parseWorkflowProgressPageQuery(query);
          if (!parsed) throw new Error("workflow_progress_invalid_query");
          return readWorkflowProgressPage(supervision, workflowReader, parsed, signal);
        },
        catch: () => new UiError({message: "Live workflow progress is unavailable. Refresh and check the T3 connection."}),
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
      chatSupervision: ({payload}) => Effect.tryPromise({
        try: signal => {if (!supervision) throw new Error("supervision_unavailable");return supervision.setChatSupervision(payload, signal);},
        catch: () => new UiError({message: "The chat supervision change could not be confirmed. Refresh to inspect the saved state."}),
      }),
      projectConfiguration: ({query}) => Effect.tryPromise({
        try: (signal) => {
          if (!definitions) throw new Error("Project definition access is not configured.");
          return definitions.load(query.projectId, query.threadId ?? null, signal).then(result => ({...result, editingAvailable: Boolean(editor)}));
        },
        catch: () => new UiError({message: "Project definition access is unavailable."}),
      }),
      saveProjectConfiguration: ({payload}) => Effect.tryPromise({
        try: signal => editor ? editor.save(payload, signal) : Promise.resolve({status: "permission_required" as const, message: "Project editing needs a dedicated filesystem:read/filesystem:write credential through deployment setup.", definitions: null}),
        catch: () => new UiError({message: "The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying."}),
      }),
      threadPolicy: ({ payload }) => Effect.try({
        try: () => {
          const policy = runtime.config.threadPolicy;
          if (!policy) throw new Error("Chat settings unavailable.");
          // each chat this editor adds or removes is a human Stop or Enable for that chat's supervision
          return supervision ? supervision.saveThreadPolicy(payload) : policy.save(payload);
        },
        catch: (cause) => new UiError({ message: cause instanceof Error ? cause.message : "Chat settings invalid. Reload first." }),
      }),
    }),
  );
  const routes = HttpApiBuilder.layer(SupervisorApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  );
  const auth = await createServiceAuth(config.dataDirectory);
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const csrf = randomBytes(32).toString("base64url");
  const activeRequests = new Set<AbortController>();
  const assets = resolve(config.uiAssetsDirectory ?? "ui-dist");
  const handle = (request: IncomingMessage, response: ServerResponse, mcpOnly: boolean) => {
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
      if (mcpOnly && url.pathname !== "/mcp/workflows")
        return reject(404, "Not found.");
      const sessionHeader = request.headers["x-supervisor-session"];
      const session = typeof sessionHeader === "string" ? sessionHeader : undefined;
      const browserRejected = (request.headers.origin && request.headers.origin !== origin) ||
        (request.headers["sec-fetch-site"] === "cross-site" && !navigation);
      if (url.pathname === "/mcp/workflows") {
        const allowedHosts = [`127.0.0.1:${request.socket.localPort ?? port}`, ...mcpHosts];
        if (!allowedHosts.includes(request.headers.host?.toLowerCase() ?? "") || browserRejected)
          return reject(403, "Workflow MCP request origin is not allowed.");
        if (!auth.mcpAuthorized(request.headers.authorization)) {
          return reject(401, "A workflow MCP token is required.");
        }
        if (!workflows) return reject(404, "Workflow MCP is unavailable.");
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        await workflows.handle(request, response);
        return;
      }
      if (request.headers.host !== `127.0.0.1:${port}` || browserRejected)
        return reject(403, "Open the supervisor through its loopback address.");
      if (url.pathname.startsWith("/auth/")) {
        if (url.pathname === "/auth/status" && request.method === "GET") {
          response.writeHead(200, {...headers, "Content-Type": "application/json"});
          response.end(JSON.stringify({authenticated: auth.authenticated(session)}));
          return;
        }
        if (request.method !== "POST" || !["/auth/login", "/auth/logout"].includes(url.pathname))
          return reject(404, "Not found.");
        if (request.headers.origin !== origin || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
          return reject(403, "Use the Supervisor sign-in page.");
        if (url.pathname === "/auth/login") {
          let payload: unknown;
          try { payload = JSON.parse(await body(request, 2048)); }
          catch (error) { if (error instanceof BodyLimitError) throw error; return reject(400, "Invalid sign-in request."); }
          const token = typeof payload === "object" && payload !== null && "token" in payload && typeof payload.token === "string" ? payload.token : "";
          const authenticated = auth.login(token);
          if (!authenticated) return reject(401, "The access token is invalid.");
          auth.logout(session);
          response.writeHead(200, {...headers, "Content-Type": "application/json"});
          response.end(JSON.stringify({authenticated: true, session: authenticated}));
          return;
        }
        auth.logout(session);
        response.writeHead(200, {...headers, "Content-Type": "application/json"});
        response.end(JSON.stringify({authenticated: false}));
        return;
      }
      if (url.pathname.startsWith("/api/") && !auth.authenticated(session))
        return reject(401, "Sign in to Supervisor.");
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
          });
          response.end(JSON.stringify({ csrf }));
          return;
        }
        const input =
          request.method === "GET" ? undefined : await body(request, 64_000);
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
        try { result = await web.handler(new Request(url, init), Context.empty() as unknown as Context.Context<unknown>); }
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
        ".png": "image/png",
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
  };
  const server = createServer((request, response) => handle(request, response, false));
  const mcpServer = config.workflowMcpBindHost ? createServer((request, response) => handle(request, response, true)) : undefined;
  const listen = (listener: typeof server, port: number, host: string) => new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => { listener.off("error", reject); resolve(); });
  });
  const stop = (listener: typeof server) => new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  try {
    await listen(server, config.uiPort ?? 9008, config.uiHost ?? "127.0.0.1");
    const address = server.address();
    if (mcpServer) await listen(mcpServer, config.workflowMcpPort ?? (typeof address === "object" && address ? address.port : config.uiPort ?? 9008), config.workflowMcpBindHost!);
  } catch (error) {
    try {
      await stop(server);
      if (mcpServer) await stop(mcpServer);
      await web.dispose();
    } finally { auth.close(); }
    throw error;
  }
  return {
    server,
    mcpServer,
    close: async () => {
      for(const controller of activeRequests)controller.abort();
      try {
        await workflows?.close();
      } finally {
        try {
          await stop(server);
          if (mcpServer) await stop(mcpServer);
          await web.dispose();
        } finally { auth.close(); }
      }
    },
  };
};
