import { ApiError } from "./errors.ts";

export type JsonRecord = Record<string, unknown>;
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class WorkerClient {
  private readonly url: string;
  private readonly serviceToken: string;
  private readonly founderId: string;
  private readonly fetcher: Fetcher;

  constructor(url: string, serviceToken: string, founderId: string, fetcher: Fetcher = fetch) {
    this.url = url;
    this.serviceToken = serviceToken;
    this.founderId = founderId;
    this.fetcher = fetcher;
  }

  async request(path: string, method = "GET", body?: unknown, mediaType = "application/json"): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.serviceToken}`, "x-founder-id": this.founderId, ...(body === undefined ? {} : { "content-type": mediaType }) },
        body: body === undefined ? undefined : mediaType === "application/json" ? JSON.stringify(body) : body as BodyInit,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch { throw new ApiError(503, "service_unavailable", "The data service could not be reached.", true); }
    if (!response.ok) {
      if (response.status === 409) {
        let code: unknown;
        try { const payload = await response.json() as { code?: unknown; error?: { code?: unknown } }; code = payload.code ?? payload.error?.code; } catch { /* A stable conflict still reaches the caller. */ }
        if (code === "poc_budget_limit") throw new ApiError(409, "poc_budget_limit", "Starting this run would exceed the remaining $10 PoC budget after reserving its approved maxUsd limit.");
        if (["run_conflict", "active_run_or_stale_approval", "resume_requires_interrupted_run", "resume_requires_verified_checkpoint", "active_run_or_resume_conflict", "resume_conflict"].includes(String(code))) {
          throw new ApiError(409, "run_conflict", "This run cannot be resumed: it must be interrupted and have a verified, unexpired checkpoint, with no other run active.");
        }
        throw new ApiError(409, "stale_approval", "The saved revision or approval conflicts with this request.");
      }
      const map: Record<number, [number, "not_found" | "expired" | "stale_approval" | "forbidden" | "invalid_request" | "rate_limited" | "service_unavailable", string]> = {
        400: [400, "invalid_request", "The data service rejected the request."],
        403: [403, "forbidden", "Access to this resource is denied."],
        404: [404, "not_found", "The resource does not exist."],
        410: [410, "expired", "This resource has expired."],
        413: [413, "invalid_request", "The archive is too large."],
        422: [422, "invalid_request", "The archive or task is invalid."],
        429: [429, "rate_limited", "The data service is rate limited."],
      };
      const [status, code, message] = map[response.status] ?? [503, "service_unavailable", "The data service could not complete the request."];
      throw new ApiError(status, code, message, status >= 500 || status === 429);
    }
    return response;
  }

  async json(path: string, method = "GET", body?: unknown): Promise<JsonRecord> {
    const response = await this.request(path, method, body);
    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data as JsonRecord;
    } catch { throw new ApiError(502, "invalid_upstream_response", "The data service returned an invalid response."); }
  }
}
