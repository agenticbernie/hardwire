import { ApiError } from "./errors.ts";
import type { Fetcher, JsonRecord } from "./worker-client.ts";
import type { ApiConfig } from "./config.ts";

export type WorkflowIdentity = { workflowRunId: string; workflowUrl: string };
export type WorkflowStatus = WorkflowIdentity & { status: string; conclusion: string | null; durationSeconds: number | null };
export type DispatchDiagnostic = { code: string; httpStatus?: number; requestId?: string };

export class GitHubDispatchError extends Error {
  readonly diagnostic: DispatchDiagnostic;

  constructor(diagnostic: DispatchDiagnostic) {
    super("GitHub workflow dispatch could not be confirmed.");
    this.name = "GitHubDispatchError";
    this.diagnostic = diagnostic;
  }
}

export class GitHubActions {
  private readonly config: Pick<ApiConfig, "githubToken" | "githubOwner" | "githubRepo" | "githubWorkflow" | "githubRef">;
  private readonly fetcher: Fetcher;
  constructor(config: GitHubActions["config"], fetcher: Fetcher = fetch) { this.config = config; this.fetcher = fetcher; }

  requireConfigured(): void {
    const c = this.config;
    if (!c.githubToken || !c.githubOwner || !c.githubRepo || !/^[a-zA-Z0-9_.-]+$/.test(c.githubOwner) || !/^[a-zA-Z0-9_.-]+$/.test(c.githubRepo)) {
      throw new ApiError(503, "missing_secret", "GitHub Actions credentials and repository must be configured.");
    }
  }

  async dispatch(runId: string): Promise<WorkflowIdentity> {
    this.requireConfigured();
    const response = await this.call(`/actions/workflows/${encodeURIComponent(this.config.githubWorkflow)}/dispatches?return_run_details=true`, "POST", { ref: this.config.githubRef, inputs: { run_id: runId } }, false, true);
    let data: JsonRecord;
    try { data = await response.json() as JsonRecord; } catch { throw this.unknown(response); }
    const id = data.workflow_run_id;
    if (!(typeof id === "string" && /^[1-9]\d*$/.test(id)) && !(typeof id === "number" && Number.isSafeInteger(id) && id > 0)) throw this.unknown(response);
    return this.identity(String(id));
  }

  async status(workflowRunId: string): Promise<WorkflowStatus> {
    const identity = this.identity(workflowRunId);
    const response = await this.call(`/actions/runs/${workflowRunId}`);
    let data: JsonRecord;
    try { data = await response.json() as JsonRecord; } catch { throw new ApiError(502, "invalid_upstream_response", "GitHub returned an invalid workflow status."); }
    if (String(data.id) !== workflowRunId || typeof data.status !== "string" || !(data.conclusion === null || typeof data.conclusion === "string")) {
      throw new ApiError(502, "invalid_upstream_response", "GitHub returned an invalid workflow status.");
    }
    const start = Date.parse(String(data.run_started_at ?? ""));
    const end = Date.parse(String(data.updated_at ?? ""));
    return { ...identity, status: data.status, conclusion: data.conclusion, durationSeconds: data.status === "completed" && Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : null };
  }

  async cancel(workflowRunId: string): Promise<void> {
    this.identity(workflowRunId);
    // A completed workflow can return 409; status polling still reconciles the actual outcome.
    await this.call(`/actions/runs/${workflowRunId}/cancel`, "POST", undefined, true);
  }

  private identity(id: string): WorkflowIdentity {
    this.requireConfigured();
    if (!/^[1-9]\d*$/.test(id)) throw new ApiError(502, "invalid_upstream_response", "The stored workflow identity is invalid.");
    return { workflowRunId: id, workflowUrl: `https://github.com/${this.config.githubOwner}/${this.config.githubRepo}/actions/runs/${id}` };
  }

  private unknown(response?: Response): GitHubDispatchError {
    const requestId = response?.headers.get("x-github-request-id");
    return new GitHubDispatchError({ code: "invalid_response", ...(response ? { httpStatus: response.status } : {}), ...(requestId ? { requestId } : {}) });
  }

  private async call(path: string, method = "GET", body?: unknown, allowConflict = false, dispatch = false): Promise<Response> {
    this.requireConfigured();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.github.com/repos/${this.config.githubOwner}/${this.config.githubRepo}${path}`, {
        method,
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.config.githubToken}`, "X-GitHub-Api-Version": "2026-03-10", "user-agent": "hardwire-poc-api", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Do not follow redirects carrying the GitHub credential. Workers supports `manual`.
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw dispatch
        ? new GitHubDispatchError({ code: "network_error" })
        : new ApiError(503, "service_unavailable", "GitHub Actions could not be reached.", true);
    }
    if (!response.ok && !(allowConflict && response.status === 409)) {
      if (dispatch) {
        const requestId = response.headers.get("x-github-request-id");
        throw new GitHubDispatchError({ code: "github_http_error", httpStatus: response.status, ...(requestId ? { requestId } : {}) });
      }
      throw new ApiError(503, "service_unavailable", "GitHub Actions could not complete the request.", true);
    }
    return response;
  }
}
