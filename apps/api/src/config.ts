import { ApiError } from "./errors.ts";

export type ApiConfig = {
  publicOrigin: string;
  founderId: string;
  founderPasswordHash: string;
  workerUrl: string;
  dataApiToken: string;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubWorkflow: string;
  githubRef: string;
  host: string;
  port: number;
};

function endpoint(value: string | undefined, name: string): string {
  try {
    const url = new URL(value ?? "");
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    if (url.pathname !== "/") throw new Error();
    return url.origin;
  } catch { throw new ApiError(503, "missing_secret", `${name} must be an HTTPS origin or a local development origin.`); }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (!env.DATA_API_TOKEN || env.DATA_API_TOKEN.length < 32) throw new ApiError(503, "missing_secret", "DATA_API_TOKEN must contain at least 32 characters.");
  if (!env.FOUNDER_PASSWORD_HASH) throw new ApiError(503, "missing_secret", "FOUNDER_PASSWORD_HASH is required.");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(503, "missing_secret", "PORT is invalid.");
  return {
    publicOrigin: endpoint(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN"),
    founderId: "founder",
    founderPasswordHash: env.FOUNDER_PASSWORD_HASH,
    workerUrl: endpoint(env.DATA_WORKER_URL, "DATA_WORKER_URL"),
    dataApiToken: env.DATA_API_TOKEN,
    githubToken: env.GITHUB_PAT,
    githubOwner: env.GITHUB_OWNER,
    githubRepo: env.GITHUB_REPO,
    githubWorkflow: env.GITHUB_WORKFLOW ?? "hardwire-poc.yml",
    githubRef: env.GITHUB_REF ?? "main",
    host: env.HOST ?? "127.0.0.1",
    port,
  };
}
