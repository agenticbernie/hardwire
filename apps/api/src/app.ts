import { extname, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MemoryFounderAuthStore } from "./auth-store.ts";
import type { FounderAuthStore } from "./auth-store.ts";
import type { ApiConfig } from "./config.ts";
import { createHonoApp } from "./hono-app.ts";
import type { WorkerBindings } from "./hono-app.ts";
import type { Fetcher } from "./worker-client.ts";

const webTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
};

async function nodeStaticAsset(request: Request, webRoot: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 404 });
  const pathname = new URL(request.url).pathname;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { return new Response(null, { status: 404 }); }
  if (decoded.includes("\\") || decoded.includes("\0")) return new Response(null, { status: 404 });
  const candidate = resolve(webRoot, `.${decoded}`);
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) return new Response(null, { status: 404 });

  let filePath = candidate;
  let bytes: Buffer;
  try { bytes = await readFile(filePath); }
  catch {
    if (extname(decoded)) return new Response(null, { status: 404 });
    filePath = resolve(webRoot, "index.html");
    try { bytes = await readFile(filePath); }
    catch { return new Response(null, { status: 404 }); }
  }

  const extension = extname(filePath).toLowerCase();
  const headers = new Headers({
    "content-type": webTypes[extension] ?? "application/octet-stream",
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  return new Response(request.method === "HEAD" ? null : new Blob([new Uint8Array(bytes)]), { status: 200, headers });
}

export function createApp(config: ApiConfig, options: { fetcher?: Fetcher; now?: () => number; webRoot?: string; serveStatic?: boolean; authStore?: FounderAuthStore } = {}) {
  const authStore = options.authStore ?? new MemoryFounderAuthStore();
  const serveStatic = options.serveStatic !== false;
  const webRoot = serveStatic
    ? resolve(options.webRoot ?? fileURLToPath(new URL("../../web/dist", import.meta.url)))
    : undefined;

  return createHonoApp(() => ({
    config,
    authStore,
    fetcher: options.fetcher,
    clientIp: "node-local",
    now: options.now,
    staticAsset: webRoot ? (request) => nodeStaticAsset(request, webRoot) : undefined,
  }));
}

export type { WorkerBindings };
