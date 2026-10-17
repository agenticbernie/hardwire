import { FounderAuth, RateLimiter } from "./auth.ts";
import { D1FounderAuthStore } from "./auth-store.ts";
import { readConfig } from "./config.ts";
import { ApiError, publicError } from "./errors.ts";
import { GitHubActions } from "./github.ts";
import { FounderService } from "./service.ts";
import { WorkerClient } from "./worker-client.ts";
import type { D1Database } from "./auth-store.ts";
import type { ApiConfig } from "./config.ts";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AUTH_DB: D1Database;
  PUBLIC_ORIGIN: string;
  FOUNDER_PASSWORD_HASH: string;
  DATA_WORKER_URL: string;
  DATA_API_TOKEN: string;
  GITHUB_PAT?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const BODY_LIMIT = 256 * 1024;
const IMPORT_LIMIT = 32 * 1024 * 1024;

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", CSP);
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers({ "cache-control": "no-store" });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return secure(Response.json(body, { status, headers: merged }));
}

async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > BODY_LIMIT) throw new ApiError(413, "invalid_request", "The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) throw new ApiError(413, "invalid_request", "The request is too large.");
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "invalid_request", "The request could not be parsed."); }
}

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); }
  catch { throw new ApiError(400, "invalid_request", "The request path is invalid."); }
}

function configuration(env: WorkerEnv): ApiConfig {
  return readConfig({
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
    FOUNDER_PASSWORD_HASH: env.FOUNDER_PASSWORD_HASH,
    DATA_WORKER_URL: env.DATA_WORKER_URL,
    DATA_API_TOKEN: env.DATA_API_TOKEN,
    GITHUB_PAT: env.GITHUB_PAT,
    GITHUB_OWNER: env.GITHUB_OWNER,
    GITHUB_REPO: env.GITHUB_REPO,
    GITHUB_WORKFLOW: env.GITHUB_WORKFLOW,
    GITHUB_REF: env.GITHUB_REF,
    HOST: "127.0.0.1",
    PORT: "8787",
  });
}

async function routeApi(request: Request, config: ApiConfig, env: WorkerEnv): Promise<Response> {
  const store = new D1FounderAuthStore(env.AUTH_DB);
  const auth = new FounderAuth(config.founderPasswordHash, config.publicOrigin, Date.now, store);
  const limiter = new RateLimiter(Date.now, store);
  const worker = new WorkerClient(config.workerUrl, config.dataApiToken, config.founderId);
  const service = new FounderService(worker, new GitHubActions(config));
  const url = new URL(request.url);
  const path = url.pathname;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  await limiter.take(`request:${ip}`, 120);
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (mutation) auth.requireOrigin(request.headers.get("origin") ?? undefined);

  if (path === "/api/auth/login" && request.method === "POST") {
    await limiter.take(`login:${ip}`, 5);
    await limiter.take("login:global", 20);
    const body = await jsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("password" in body)) {
      throw new ApiError(400, "invalid_request", "A founder password is required.");
    }
    const result = await auth.login((body as { password: unknown }).password);
    return jsonResponse({ founder: { id: config.founderId }, csrfToken: result.csrfToken, expiresAt: result.expiresAt }, 200, { "set-cookie": result.cookie });
  }

  const session = await auth.session(request.headers.get("cookie") ?? undefined);
  if (mutation) auth.requireCsrf(session, request.headers.get("x-csrf-token") ?? undefined);

  if (path === "/api/auth/session" && request.method === "GET") {
    return jsonResponse({ founder: { id: config.founderId }, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    return secure(new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": await auth.logout() } }));
  }

  if (path === "/api/projects" && request.method === "POST") return jsonResponse(await service.createProject(await jsonBody(request)), 201);
  if (path === "/api/projects" && request.method === "GET") return jsonResponse(await service.projects());
  if (path === "/api/usage" && request.method === "GET") return jsonResponse(await service.usage());

  if (path === "/api/projects/import" && request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > IMPORT_LIMIT + 1024 * 1024) throw new ApiError(413, "invalid_request", "The archive is too large.");
    let form: FormData;
    try { form = await request.formData(); }
    catch { throw new ApiError(400, "invalid_request", "Upload one .hardwire.zip file in the file field."); }
    const fields: [string, FormDataEntryValue][] = [];
    form.forEach((value, key) => fields.push([key, value]));
    const file = fields[0]?.[1];
    if (fields.length !== 1 || fields[0]?.[0] !== "file" || typeof file === "string" || !file.name.endsWith(".hardwire.zip")) {
      throw new ApiError(400, "invalid_request", "Upload one .hardwire.zip file in the file field.");
    }
    if (file.size > IMPORT_LIMIT) throw new ApiError(413, "invalid_request", "The archive is too large.");
    return jsonResponse(await service.importProject(Buffer.from(await file.arrayBuffer())), 201);
  }

  const projectPath = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectPath && request.method === "GET") return jsonResponse(await service.project(decodeSegment(projectPath[1]!)));
  const projectTaskPath = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
  if (projectTaskPath && request.method === "POST") return jsonResponse(await service.createTask(decodeSegment(projectTaskPath[1]!), await jsonBody(request)), 201);
  const projectExportPath = path.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (projectExportPath && request.method === "POST") return jsonResponse(await service.exportProject(decodeSegment(projectExportPath[1]!)), 201);

  const taskPath = path.match(/^\/api\/tasks\/([^/]+)\/(approve|revisions|runs)$/);
  if (taskPath) {
    const id = decodeSegment(taskPath[1]!);
    const action = taskPath[2];
    if (action === "approve" && request.method === "POST") return jsonResponse(await service.approve(id, await jsonBody(request)));
    if (action === "revisions" && request.method === "POST") return jsonResponse(await service.reviseTask(id, await jsonBody(request)), 201);
    if (action === "runs" && request.method === "POST") return jsonResponse(await service.start(id, await jsonBody(request)), 202);
  }

  const runPath = path.match(/^\/api\/runs\/([^/]+)(?:\/(cancel|resume))?$/);
  if (runPath) {
    const id = decodeSegment(runPath[1]!);
    const action = runPath[2];
    if (!action && request.method === "GET") return jsonResponse(await service.run(id));
    if (action === "cancel" && request.method === "POST") return jsonResponse(await service.cancel(id), 202);
    if (action === "resume" && request.method === "POST") return jsonResponse(await service.resume(id, await jsonBody(request)), 202);
  }

  const downloadPath = path.match(/^\/api\/(artifacts|exports)\/([^/]+)$/);
  if (downloadPath && request.method === "GET") {
    const kind = downloadPath[1] as "artifacts" | "exports";
    const id = decodeSegment(downloadPath[2]!);
    const upstream = await service.download(kind, id);
    const mediaType = upstream.headers.get("content-type")?.split(";")[0];
    const headers = new Headers({
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${id}${kind === "exports" ? ".hardwire.zip" : mediaType === "image/png" ? ".png" : ".bin"}"`,
    });
    headers.set("content-type", kind === "artifacts" && mediaType === "image/png" ? "image/png" : "application/octet-stream");
    const length = upstream.headers.get("content-length");
    if (length && /^\d+$/.test(length)) headers.set("content-length", length);
    if (!upstream.body) throw new ApiError(502, "invalid_upstream_response", "The download service returned an empty body.");
    return secure(new Response(upstream.body, { status: 200, headers }));
  }

  throw new ApiError(404, "not_found", "The requested API route does not exist.");
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" && request.method === "GET") return jsonResponse({ healthy: true });
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return secure(await env.ASSETS.fetch(request));
    try { return await routeApi(request, configuration(env), env); }
    catch (error) {
      const result = publicError(error);
      const headers = result.status === 429 ? { "retry-after": "60" } : undefined;
      return jsonResponse(result.body, result.status, headers);
    }
  },
};
