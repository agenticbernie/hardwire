export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T = unknown>(statements: Statement[]): Promise<T[]>;
}
export interface BucketObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface Bucket {
  put(key: string, value: Uint8Array | ReadableStream<Uint8Array>, options?: unknown): Promise<unknown>;
  get(key: string): Promise<BucketObject | null>;
  delete(key: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[]; truncated: boolean; cursor?: string;
  }>;
}
export interface Env {
  DB: Database;
  ARTIFACTS: Bucket;
  DATA_API_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_WORKFLOW_REF: string;
  OIDC_AUDIENCE: string;
  RETENTION_SECONDS?: string;
}
export type Row = Record<string, any>;
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function requireCondition(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new HttpError(status, code);
}
export async function sha256(value: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), b => b.toString(16).padStart(2, '0')).join('');
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export function retention(env: Env): number {
  const seconds = Number(env.RETENTION_SECONDS ?? 259200);
  requireCondition(Number.isInteger(seconds) && seconds > 0 && seconds <= 259200, 503, 'invalid_retention_configuration');
  return seconds * 1000;
}
export async function boundedBytes(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared) requireCondition(Number(declared) <= max, 413, 'body_too_large');
  const reader = request.body?.getReader();
  requireCondition(reader, 400, 'empty_body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      requireCondition(size <= max, 413, 'body_too_large');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
