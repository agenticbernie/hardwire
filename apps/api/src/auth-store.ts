import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";

export type FounderSession = { csrfToken: string; expiresAt: number };

export interface FounderAuthStore {
  rotateSession(tokenHash: string, session: FounderSession, now: number): Promise<void>;
  session(tokenHash: string, now: number): Promise<FounderSession | undefined>;
  clearSessions(): Promise<void>;
  takeRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<void>;
}

export class MemoryFounderAuthStore implements FounderAuthStore {
  private readonly sessions = new Map<string, FounderSession>();
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  async rotateSession(tokenHash: string, session: FounderSession, now: number): Promise<void> {
    this.prune(now);
    this.sessions.clear();
    this.sessions.set(tokenHash, session);
  }

  async session(tokenHash: string, now: number): Promise<FounderSession | undefined> {
    this.prune(now);
    return this.sessions.get(tokenHash);
  }

  async clearSessions(): Promise<void> { this.sessions.clear(); }

  async takeRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<void> {
    this.prune(now);
    const current = this.buckets.get(key);
    if (current && current.count >= limit) throw new ApiError(429, "rate_limited", "Too many requests. Try again later.", true);
    if (!current && this.buckets.size >= 10_000) throw new ApiError(429, "rate_limited", "Too many requests. Try again later.", true);
    this.buckets.set(key, { count: (current?.count ?? 0) + 1, expiresAt: current?.expiresAt ?? now + windowMs });
  }

  private prune(now: number): void {
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
  }
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

type SessionRow = { csrf_token: string; expires_at: number };
type RateLimitRow = { bucket_count: number };

/** Durable founder auth state for Workers. Rate-limit keys are hashed before persistence. */
export class D1FounderAuthStore implements FounderAuthStore {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async rotateSession(tokenHash: string, session: FounderSession, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM founder_sessions").bind(),
      this.db.prepare("INSERT INTO founder_sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?)").bind(tokenHash, session.csrfToken, session.expiresAt, now),
    ]);
  }

  async session(tokenHash: string, now: number): Promise<FounderSession | undefined> {
    const row = await this.db.prepare("SELECT csrf_token,expires_at FROM founder_sessions WHERE token_hash=? AND expires_at>?")
      .bind(tokenHash, now).first<SessionRow>();
    return row ? { csrfToken: row.csrf_token, expiresAt: row.expires_at } : undefined;
  }

  async clearSessions(): Promise<void> {
    await this.db.prepare("DELETE FROM founder_sessions").bind().run();
  }

  async takeRateLimit(key: string, limit: number, windowMs: number, now: number): Promise<void> {
    const keyHash = createHash("sha256").update(key).digest("hex");
    const statement = this.db.prepare(`
      INSERT INTO founder_rate_limits(bucket_hash,bucket_count,expires_at)
      SELECT ?,1,? WHERE EXISTS(
        SELECT 1 FROM founder_rate_limits WHERE bucket_hash=? AND expires_at>?
      ) OR (SELECT COUNT(*) FROM founder_rate_limits WHERE expires_at>?)<10000
      ON CONFLICT(bucket_hash) DO UPDATE SET
        bucket_count=CASE WHEN founder_rate_limits.expires_at<=? THEN 1 ELSE MIN(founder_rate_limits.bucket_count+1, ?) END,
        expires_at=CASE WHEN founder_rate_limits.expires_at<=? THEN excluded.expires_at ELSE founder_rate_limits.expires_at END
      RETURNING bucket_count
    `).bind(keyHash, now + windowMs, keyHash, now, now, now, limit + 1, now);
    const row = await statement.first<RateLimitRow>();
    if (!row || row.bucket_count > limit) throw new ApiError(429, "rate_limited", "Too many requests. Try again later.", true);
  }
}
