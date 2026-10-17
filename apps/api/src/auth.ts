import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ApiError } from "./errors.ts";

const derive = promisify(scrypt);
export const SESSION_COOKIE = "__Host-hardwire_session";
const SESSION_SECONDS = 8 * 60 * 60;
type Session = { csrfToken: string; expiresAt: number };

export async function passwordHash(password: string, salt = randomBytes(16).toString("hex")): Promise<string> {
  const hash = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

export class FounderAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly passwordDigest: string;
  private readonly origin: string;
  private readonly now: () => number;

  constructor(passwordDigest: string, origin: string, now = Date.now) {
    if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordDigest)) {
      throw new ApiError(503, "missing_secret", "A valid founder password hash must be configured.");
    }
    this.passwordDigest = passwordDigest;
    this.origin = origin;
    this.now = now;
  }

  requireOrigin(origin: string | undefined): void {
    if (origin !== this.origin) throw new ApiError(403, "forbidden", "Request origin is not allowed.");
  }

  async login(password: unknown): Promise<{ cookie: string; csrfToken: string; expiresAt: string }> {
    if (typeof password !== "string" || password.length < 1 || password.length > 1024) {
      throw new ApiError(401, "unauthorized", "Invalid founder credentials.");
    }
    const [, salt, expected] = this.passwordDigest.split(":") as [string, string, string];
    const actual = await derive(password, salt, 64) as Buffer;
    if (!timingSafeEqual(actual, Buffer.from(expected, "hex"))) {
      throw new ApiError(401, "unauthorized", "Invalid founder credentials.");
    }
    this.prune();
    // This is one founder account; rotate all existing sessions on successful login.
    this.sessions.clear();
    const token = randomBytes(32).toString("hex");
    const session = { csrfToken: randomBytes(32).toString("hex"), expiresAt: this.now() + SESSION_SECONDS * 1000 };
    this.sessions.set(this.key(token), session);
    return { cookie: this.cookie(token, SESSION_SECONDS), csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  session(cookieHeader?: string): Session {
    this.prune();
    const token = cookieHeader?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, "unauthorized", "Founder login is required.");
    const session = this.sessions.get(this.key(token));
    if (!session) throw new ApiError(401, "unauthorized", "Founder login is required.");
    return session;
  }

  requireCsrf(session: Session, csrf: string | undefined): void {
    if (!csrf || !/^[a-f0-9]{64}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrfToken))) {
      throw new ApiError(403, "forbidden", "A valid CSRF token is required.");
    }
  }

  logout(): string {
    this.sessions.clear();
    return this.cookie("", 0);
  }

  private cookie(token: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
  }

  private key(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private prune(): void {
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();
  private readonly now: () => number;
  constructor(now = Date.now) { this.now = now; }

  take(key: string, limit: number, windowMs = 60_000): void {
    const now = this.now();
    for (const [candidate, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(candidate);
    const current = this.buckets.get(key);
    if (current && current.count >= limit) throw new ApiError(429, "rate_limited", "Too many requests. Try again later.", true);
    if (!current && this.buckets.size >= 10_000) throw new ApiError(429, "rate_limited", "Too many requests. Try again later.", true);
    this.buckets.set(key, { count: (current?.count ?? 0) + 1, expiresAt: current?.expiresAt ?? now + windowMs });
  }
}
