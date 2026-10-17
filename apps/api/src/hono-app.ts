import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { FounderAuth, RateLimiter } from "./auth.ts";
import type { FounderAuthStore } from "./auth-store.ts";
import { ApiError, publicError } from "./errors.ts";
import { GitHubActions } from "./github.ts";
import { FounderService } from "./service.ts";
import { WorkerClient } from "./worker-client.ts";
import type { ApiConfig } from "./config.ts";
import type { Fetcher } from "./worker-client.ts";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const BODY_LIMIT = 256 * 1024;
const IMPORT_LIMIT = 32 * 1024 * 1024;
const IMPORT_ENVELOPE_LIMIT = IMPORT_LIMIT + 1024 * 1024;

export interface WorkerBindings {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  DATA_SERVICE?: { fetch(request: Request): Promise<Response> };
  AUTH_DB?: unknown;
  PUBLIC_ORIGIN?: string;
  FOUNDER_PASSWORD_HASH?: string;
  DATA_WORKER_URL?: string;
  DATA_API_TOKEN?: string;
  GITHUB_PAT?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
}

export interface ApiRuntime {
  config: ApiConfig;
  authStore: FounderAuthStore;
  fetcher?: Fetcher;
  /** Runtime-specific IP source; Worker deployments use cf-connecting-ip. */
  clientIp?: string;
  staticAsset?: (request: Request) => Promise<Response | undefined>;
  now?: () => number;
}

interface Variables {
  runtime: ApiRuntime;
  auth: FounderAuth;
  limiter: RateLimiter;
  service: FounderService;
  session?: { csrfToken: string; expiresAt: number };
}

type HonoEnv = { Bindings: WorkerBindings; Variables: Variables };

export type RuntimeResolver = (bindings: WorkerBindings, request: Request) => ApiRuntime;

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", CSP);
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readLimited(request: Request, limit: number, tooLargeMessage: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) throw new ApiError(413, "invalid_request", tooLargeMessage);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        try { await reader.cancel(); } catch { /* Preserve the size-limit response if the stream is already failing. */ }
        throw new ApiError(413, "invalid_request", tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function jsonBody(request: Request): Promise<unknown> {
  const bytes = await readLimited(request, BODY_LIMIT, "The request is too large.");
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "invalid_request", "The request could not be parsed."); }
}

async function multipartBody(request: Request): Promise<FormData> {
  const bytes = await readLimited(request, IMPORT_ENVELOPE_LIMIT, "The archive is too large.");
  const bounded = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
  try { return await bounded.formData(); }
  catch { throw new ApiError(400, "invalid_request", "Upload one .hardwire.zip file in the file field."); }
}

function invalidArchiveRequest(): ApiError {
  return new ApiError(400, "invalid_request", "Upload one .hardwire.zip file in the file field.");
}

export function createHonoApp(resolveRuntime: RuntimeResolver) {
  const app = new Hono<HonoEnv>();

  app.use("*", async (c, next) => {
    c.header("x-content-type-options", "nosniff");
    c.header("content-security-policy", CSP);
    c.header("referrer-policy", "no-referrer");

    const { pathname } = new URL(c.req.url);
    const method = c.req.method;
    const isHealth = pathname === "/healthz" && method === "GET";
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    if (isHealth) {
      c.header("cache-control", "no-store");
      await next();
      return;
    }

    // Worker Assets handles ordinary static reads outside the Worker-first routes.
    // Do not require application secrets just to serve those files.
    if (!isApi && c.env?.ASSETS) {
      await next();
      return;
    }

    const runtime = resolveRuntime(c.env ?? {}, c.req.raw);
    const now = runtime.now ?? Date.now;
    const auth = new FounderAuth(runtime.config.founderPasswordHash, runtime.config.publicOrigin, now, runtime.authStore);
    const limiter = new RateLimiter(now, runtime.authStore);
    const worker = new WorkerClient(runtime.config.workerUrl, runtime.config.dataApiToken, runtime.config.founderId, runtime.fetcher);
    const service = new FounderService(worker, new GitHubActions(runtime.config, runtime.fetcher));
    c.set("runtime", runtime);
    c.set("auth", auth);
    c.set("limiter", limiter);
    c.set("service", service);

    if (isApi) c.header("cache-control", "no-store");
    const ip = runtime.clientIp ?? c.req.header("cf-connecting-ip") ?? "unknown";
    await limiter.take(`request:${ip}`, 120);

    const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isApi && !mutation && (method === "GET" || method === "HEAD")) {
      await next();
      return;
    }
    if (mutation) auth.requireOrigin(c.req.header("origin"));

    if (pathname === "/api/auth/login" && method === "POST") {
      await limiter.take(`login:${ip}`, 5);
      await limiter.take("login:global", 20);
      await next();
      return;
    }

    const session = await auth.session(c.req.header("cookie"));
    c.set("session", session);
    if (mutation) auth.requireCsrf(session, c.req.header("x-csrf-token"));
    await next();
  });

  app.onError((error, c) => {
    const source = error as { statusCode?: number; code?: string };
    let safe: unknown = error;
    if (!(error instanceof ApiError) && source.statusCode && source.statusCode >= 400 && source.statusCode < 500) {
      safe = new ApiError(source.statusCode, "invalid_request", source.statusCode === 413 ? "The request is too large." : "The request could not be parsed.");
    }
    const result = publicError(safe);
    if (result.status === 429) c.header("retry-after", "60");
    return c.json(result.body, result.status as ContentfulStatusCode);
  });

  app.get("/healthz", (c) => c.json({ healthy: true }));

  app.post("/api/auth/login", async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("password" in body)) {
      throw new ApiError(400, "invalid_request", "A founder password is required.");
    }
    const runtime = c.get("runtime");
    const result = await c.get("auth").login((body as { password: unknown }).password);
    return c.json({ founder: { id: runtime.config.founderId }, csrfToken: result.csrfToken, expiresAt: result.expiresAt }, 200, { "set-cookie": result.cookie });
  });

  app.get("/api/auth/session", (c) => {
    const session = c.get("session");
    if (!session) throw new ApiError(401, "unauthorized", "Founder login is required.");
    return c.json({ founder: { id: c.get("runtime").config.founderId }, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  app.post("/api/auth/logout", async (c) => {
    c.header("set-cookie", await c.get("auth").logout());
    return c.body(null, 204);
  });

  app.post("/api/projects", async (c) => c.json(await c.get("service").createProject(await jsonBody(c.req.raw)), 201));
  app.get("/api/projects", async (c) => c.json(await c.get("service").projects()));
  app.get("/api/projects/:projectId", async (c) => c.json(await c.get("service").project(c.req.param("projectId"))));
  app.post("/api/projects/:projectId/tasks", async (c) => c.json(await c.get("service").createTask(c.req.param("projectId"), await jsonBody(c.req.raw)), 201));
  app.post("/api/projects/:projectId/export", async (c) => c.json(await c.get("service").exportProject(c.req.param("projectId")), 201));

  app.post("/api/projects/import", async (c) => {
    const form = await multipartBody(c.req.raw);
    const fields: [string, FormDataEntryValue][] = [];
    form.forEach((value, key) => fields.push([key, value]));
    if (fields.length > 1) throw new ApiError(413, "invalid_request", "The request is too large.");
    const file = fields[0]?.[1];
    if (fields.length !== 1 || fields[0]?.[0] !== "file" || typeof file === "string" || !file.name.endsWith(".hardwire.zip")) throw invalidArchiveRequest();
    if (file.size > IMPORT_LIMIT) throw new ApiError(413, "invalid_request", "The archive is too large.");
    return c.json(await c.get("service").importProject(Buffer.from(await file.arrayBuffer())), 201);
  });

  app.post("/api/tasks/:taskId/approve", async (c) => c.json(await c.get("service").approve(c.req.param("taskId"), await jsonBody(c.req.raw))));
  app.post("/api/tasks/:taskId/revisions", async (c) => c.json(await c.get("service").reviseTask(c.req.param("taskId"), await jsonBody(c.req.raw)), 201));
  app.post("/api/tasks/:taskId/runs", async (c) => c.json(await c.get("service").start(c.req.param("taskId"), await jsonBody(c.req.raw)), 202));

  app.get("/api/runs/:runId", async (c) => c.json(await c.get("service").run(c.req.param("runId"))));
  app.post("/api/runs/:runId/cancel", async (c) => c.json(await c.get("service").cancel(c.req.param("runId")), 202));
  app.post("/api/runs/:runId/resume", async (c) => c.json(await c.get("service").resume(c.req.param("runId"), await jsonBody(c.req.raw)), 202));
  app.get("/api/usage", async (c) => c.json(await c.get("service").usage()));

  for (const kind of ["artifacts", "exports"] as const) {
    app.get(`/api/${kind}/:id`, async (c) => {
      const id = c.req.param("id");
      const upstream = await c.get("service").download(kind, id);
      const mediaType = upstream.headers.get("content-type")?.split(";")[0];
      const headers: Record<string, string> = {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${id}${kind === "exports" ? ".hardwire.zip" : mediaType === "image/png" ? ".png" : ".bin"}"`,
        "content-type": kind === "artifacts" && mediaType === "image/png" ? "image/png" : "application/octet-stream",
      };
      const length = upstream.headers.get("content-length");
      if (length && /^\d+$/.test(length)) headers["content-length"] = length;
      if (!upstream.body) throw new ApiError(502, "invalid_upstream_response", "The download service returned an empty body.");
      return c.body(upstream.body, 200, headers);
    });
  }

  app.notFound(async (c) => {
    const { pathname } = new URL(c.req.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const result = publicError(new ApiError(404, "not_found", "The requested API route does not exist."));
      return c.json(result.body, 404);
    }
    if (c.env?.ASSETS) return secureResponse(await c.env.ASSETS.fetch(c.req.raw));
    const staticAsset = c.get("runtime")?.staticAsset;
    const response = await staticAsset?.(c.req.raw);
    return response ? secureResponse(response) : c.body(null, 404);
  });

  return app;
}
