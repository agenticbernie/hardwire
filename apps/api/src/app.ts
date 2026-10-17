import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FounderAuth, RateLimiter } from "./auth.ts";
import { ApiError, publicError } from "./errors.ts";
import { GitHubActions } from "./github.ts";
import { FounderService } from "./service.ts";
import { WorkerClient } from "./worker-client.ts";
import type { ApiConfig } from "./config.ts";
import type { Fetcher } from "./worker-client.ts";

const webRoot = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const webTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
};

export async function createApp(config: ApiConfig, options: { fetcher?: Fetcher; now?: () => number; webRoot?: string } = {}) {
  const servedWebRoot = options.webRoot ? resolve(options.webRoot) : webRoot;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false, requestTimeout: 60_000 });
  const auth = new FounderAuth(config.founderPasswordHash, config.publicOrigin, options.now);
  const limiter = new RateLimiter(options.now);
  const worker = new WorkerClient(config.workerUrl, config.dataApiToken, config.founderId, options.fetcher);
  const service = new FounderService(worker, new GitHubActions(config, options.fetcher));

  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    reply.header("referrer-policy", "no-referrer");
    if (request.url === "/healthz" && request.method === "GET") return;
    limiter.take(`request:${request.ip}`, 120);
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const pathname = new URL(request.url, config.publicOrigin).pathname;
    // The login shell and its hashed assets must be available before a founder
    // session exists. Product data remains behind the authenticated /api space.
    if (!pathname.startsWith("/api/") && !mutation && (request.method === "GET" || request.method === "HEAD")) return;
    if (mutation) auth.requireOrigin(typeof request.headers.origin === "string" ? request.headers.origin : undefined);
    if (request.url === "/api/auth/login" && request.method === "POST") {
      limiter.take(`login:${request.ip}`, 5);
      limiter.take("login:global", 20);
      return;
    }
    const session = auth.session(request.headers.cookie);
    if (mutation) auth.requireCsrf(session, typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined);
  });

  app.setErrorHandler((error, _request, reply) => {
    const source = error as { statusCode?: number; code?: string };
    let safe: unknown = error;
    if (!(error instanceof ApiError) && source.statusCode && source.statusCode >= 400 && source.statusCode < 500) {
      safe = new ApiError(source.statusCode, "invalid_request", source.statusCode === 413 ? "The request is too large." : "The request could not be parsed.");
    }
    const result = publicError(safe);
    if (result.status === 429) reply.header("retry-after", "60");
    // Never return or log upstream bodies, request headers, cookie values, or stack traces.
    reply.code(result.status).send(result.body);
  });

  app.get("/healthz", async () => ({ healthy: true }));
  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("password" in body)) throw new ApiError(400, "invalid_request", "A founder password is required.");
    const result = await auth.login((body as { password: unknown }).password);
    reply.header("set-cookie", result.cookie);
    return { founder: { id: config.founderId }, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  });
  app.get("/api/auth/session", async (request) => {
    const session = auth.session(request.headers.cookie);
    return { founder: { id: config.founderId }, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  });
  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", auth.logout());
    reply.code(204).send();
  });

  app.post("/api/projects", async (request, reply) => {
    const result = await service.createProject(request.body);
    return reply.code(201).send(result);
  });
  app.get("/api/projects", async () => service.projects());
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) => service.project(request.params.projectId));
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/tasks", async (request, reply) => {
    const result = await service.createTask(request.params.projectId, request.body);
    return reply.code(201).send(result);
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/approve", async (request) => service.approve(request.params.taskId, request.body));
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/revisions", async (request, reply) => reply.code(201).send(await service.reviseTask(request.params.taskId, request.body)));
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/runs", async (request, reply) => reply.code(202).send(await service.start(request.params.taskId, request.body)));
  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request) => service.run(request.params.runId));
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/resume", async (request, reply) => reply.code(202).send(await service.resume(request.params.runId, request.body)));
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", async (request, reply) => reply.code(202).send(await service.cancel(request.params.runId)));
  app.get("/api/usage", async () => service.usage());
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/export", async (request, reply) => reply.code(201).send(await service.exportProject(request.params.projectId)));
  app.post("/api/projects/import", async (request, reply) => {
    let bytes: Buffer | undefined;
    // Finish parsing the whole multipart envelope before any Worker write. A
    // second file/field must not be discovered only after an import was saved.
    for await (const part of request.parts()) {
      if (part.type !== "file" || bytes || part.fieldname !== "file" || !part.filename.endsWith(".hardwire.zip")) throw new ApiError(400, "invalid_request", "Upload one .hardwire.zip file in the file field.");
      bytes = await part.toBuffer();
    }
    if (!bytes) throw new ApiError(400, "invalid_request", "Upload one .hardwire.zip file in the file field.");
    return reply.code(201).send(await service.importProject(bytes));
  });
  for (const kind of ["artifacts", "exports"] as const) {
    app.get<{ Params: { id: string } }>(`/api/${kind}/:id`, async (request, reply) => {
      const response = await service.download(kind, request.params.id);
      const mediaType = response.headers.get("content-type")?.split(";")[0];
      reply.type(kind === "artifacts" && mediaType === "image/png" ? "image/png" : "application/octet-stream");
      reply.header("content-disposition", `attachment; filename="${request.params.id}${kind === "exports" ? ".hardwire.zip" : mediaType === "image/png" ? ".png" : ".bin"}"`);
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length)) reply.header("content-length", length);
      if (!response.body) throw new ApiError(502, "invalid_upstream_response", "The download service returned an empty body.");
      return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
    });
  }
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, "http://hardwire.local").pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return reply.code(404).send(publicError(new ApiError(404, "not_found", "The requested API route does not exist.")).body);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return reply.code(404).send();
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return reply.code(404).send(); }
    if (decoded.includes("\\") || decoded.includes("\0")) return reply.code(404).send();
    const candidate = resolve(servedWebRoot, `.${decoded}`);
    if (candidate !== servedWebRoot && !candidate.startsWith(`${servedWebRoot}${sep}`)) return reply.code(404).send();
    let filePath = candidate;
    let bytes: Buffer;
    try { bytes = await readFile(filePath); }
    catch (error) {
      if (extname(decoded)) return reply.code(404).send();
      filePath = resolve(servedWebRoot, "index.html");
      try { bytes = await readFile(filePath); }
      catch { return reply.code(404).send(); }
    }
    const extension = extname(filePath).toLowerCase();
    reply.type(webTypes[extension] ?? "application/octet-stream");
    reply.header("cache-control", extension === ".html" ? "no-store" : "public, max-age=31536000, immutable");
    if (request.method === "HEAD") return reply.send();
    return reply.send(bytes);
  });
  return app;
}
