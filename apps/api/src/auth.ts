import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ApiError } from "./errors.ts";
import { MemoryFounderAuthStore } from "./auth-store.ts";
import type { FounderAuthStore, FounderSession } from "./auth-store.ts";

const derive = promisify(scrypt);
export const SESSION_COOKIE = "__Host-hardwire_session";
const SESSION_SECONDS = 8 * 60 * 60;
type Session = FounderSession;

export async function passwordHash(password: string, salt = randomBytes(16).toString("hex")): Promise<string> {
  const hash = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}

export class FounderAuth {
  private readonly passwordDigest: string;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly store: FounderAuthStore;

  constructor(passwordDigest: string, origin: string, now = Date.now, store: FounderAuthStore = new MemoryFounderAuthStore()) {
    if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordDigest)) {
      throw new ApiError(503, "missing_secret", "A valid founder password hash must be configured.");
    }
    this.passwordDigest = passwordDigest;
    this.origin = origin;
    this.now = now;
    this.store = store;
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
    const token = randomBytes(32).toString("hex");
    const session = { csrfToken: randomBytes(32).toString("hex"), expiresAt: this.now() + SESSION_SECONDS * 1000 };
    // This is one founder account; rotate all existing sessions on successful login.
    await this.store.rotateSession(this.key(token), session, this.now());
    return { cookie: this.cookie(token, SESSION_SECONDS), csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  async session(cookieHeader?: string): Promise<Session> {
    const token = cookieHeader?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, "unauthorized", "Founder login is required.");
    const session = await this.store.session(this.key(token), this.now());
    if (!session) throw new ApiError(401, "unauthorized", "Founder login is required.");
    return session;
  }

  requireCsrf(session: Session, csrf: string | undefined): void {
    if (!csrf || !/^[a-f0-9]{64}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrfToken))) {
      throw new ApiError(403, "forbidden", "A valid CSRF token is required.");
    }
  }

  async logout(): Promise<string> {
    await this.store.clearSessions();
    return this.cookie("", 0);
  }

  private cookie(token: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
  }

  private key(token: string): string { return createHash("sha256").update(token).digest("hex"); }
}

export class RateLimiter {
  private readonly now: () => number;
  private readonly store: FounderAuthStore;
  constructor(now = Date.now, store: FounderAuthStore = new MemoryFounderAuthStore()) { this.now = now; this.store = store; }

  async take(key: string, limit: number, windowMs = 60_000): Promise<void> {
    await this.store.takeRateLimit(key, limit, windowMs, this.now());
  }
}
