export type ErrorCode = "invalid_request" | "unauthorized" | "forbidden" | "rate_limited"
  | "not_found" | "expired" | "stale_approval" | "run_conflict" | "missing_secret"
  | "poc_budget_limit" | "service_unavailable" | "dispatch_unknown" | "invalid_upstream_response" | "internal_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(status: number, code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function publicError(error: unknown): { status: number; body: { error: { code: ErrorCode; message: string; retryable: boolean } } } {
  const safe = error instanceof ApiError ? error : new ApiError(500, "internal_error", "The request could not be completed.");
  return { status: safe.status, body: { error: { code: safe.code, message: safe.message, retryable: safe.retryable } } };
}
