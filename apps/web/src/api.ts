export type ApiErrorBody = {
  error?: { code?: string; message?: string; retryable?: boolean };
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function responseError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }
  return new ApiError(
    response.status,
    body?.error?.code || "request_failed",
    body?.error?.message || "Không thể hoàn tất yêu cầu. Hãy thử lại.",
    body?.error?.retryable === true,
  );
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrfToken?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method || "GET";
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  if (mutating && options.csrfToken) headers.set("x-csrf-token", options.csrfToken);

  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined
      ? undefined
      : options.body instanceof FormData
        ? options.body
        : JSON.stringify(options.body),
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
  });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function apiDownload(path: string): Promise<Blob> {
  if (!path.startsWith("/api/") || path.startsWith("//")) {
    throw new ApiError(400, "invalid_download_path", "Đường dẫn tải xuống không hợp lệ.");
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/octet-stream, image/png" },
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
