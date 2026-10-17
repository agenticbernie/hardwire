import { D1FounderAuthStore } from "./auth-store.ts";
import type { D1Database } from "./auth-store.ts";
import { readConfig } from "./config.ts";
import { createHonoApp } from "./hono-app.ts";
import type { WorkerBindings } from "./hono-app.ts";
import type { Fetcher } from "./worker-client.ts";

export function createServiceBindingFetcher(binding: NonNullable<WorkerBindings["DATA_SERVICE"]>): Fetcher {
  return (input, init) => binding.fetch(new Request(input, init));
}

function configuration(env: WorkerBindings) {
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

const app = createHonoApp((env, request) => ({
  config: configuration(env),
  authStore: new D1FounderAuthStore(env.AUTH_DB as D1Database),
  fetcher: env.DATA_SERVICE ? createServiceBindingFetcher(env.DATA_SERVICE) : undefined,
  clientIp: request.headers.get("cf-connecting-ip") ?? "unknown",
}));

export default {
  fetch(request: Request, env: WorkerBindings): Promise<Response> {
    return Promise.resolve(app.fetch(request, env));
  },
};
