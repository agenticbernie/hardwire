import { HttpError, requireCondition, sha256 } from './types.ts';
import type { Env, Row } from './types.ts';

const issuer = 'https://token.actions.githubusercontent.com';
let jwksCache: { expires: number; keys: (JsonWebKey & { kid?: string })[] } | undefined;

function decodePart(part: string): Uint8Array<ArrayBuffer> {
  requireCondition(/^[A-Za-z0-9_-]+$/.test(part), 401, 'invalid_oidc');
  const text = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4));
  return Uint8Array.from(text, char => char.charCodeAt(0));
}

export async function validateOidc(token: string, env: Env, run: Row, fetcher: typeof fetch = fetch): Promise<Row> {
  requireCondition(typeof token === 'string' && token.length < 16384, 401, 'invalid_oidc');
  const parts = token.split('.');
  requireCondition(parts.length === 3, 401, 'invalid_oidc');
  let header: Row, claims: Row;
  try {
    header = JSON.parse(new TextDecoder().decode(decodePart(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1]!)));
  } catch { throw new HttpError(401, 'invalid_oidc'); }
  requireCondition(header.alg === 'RS256' && typeof header.kid === 'string', 401, 'invalid_oidc_algorithm');
  // Never follow a token-provided jku/x5u or redirect to an arbitrary key source.
  if (!jwksCache || jwksCache.expires <= Date.now() || !jwksCache.keys.some(key => key.kid === header.kid)) {
    const response = await fetcher(`${issuer}/.well-known/jwks`, { redirect: 'manual' });
    requireCondition(response.ok, 503, 'oidc_keys_unavailable');
    const document = await response.json() as { keys: (JsonWebKey & { kid?: string })[] };
    requireCondition(Array.isArray(document.keys), 503, 'oidc_keys_unavailable');
    jwksCache = { keys: document.keys, expires: Date.now() + 300000 };
  }
  const jwk = jwksCache.keys.find(key => key.kid === header.kid && key.kty === 'RSA');
  requireCondition(jwk, 401, 'unknown_oidc_key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodePart(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  requireCondition(verified, 401, 'invalid_oidc_signature');
  const now = Date.now() / 1000;
  requireCondition(claims.iss === issuer && (claims.aud === env.OIDC_AUDIENCE || Array.isArray(claims.aud) && claims.aud.includes(env.OIDC_AUDIENCE)), 401, 'invalid_oidc_audience');
  requireCondition(typeof claims.exp === 'number' && claims.exp > now && typeof claims.nbf === 'number' && claims.nbf <= now + 30 && typeof claims.iat === 'number' && claims.iat <= now + 30 && claims.iat >= now - 600, 401, 'expired_oidc');
  requireCondition(claims.repository === env.GITHUB_REPOSITORY && claims.workflow_ref === env.GITHUB_WORKFLOW_REF && claims.event_name === 'workflow_dispatch', 403, 'oidc_workflow_mismatch');
  requireCondition(typeof claims.jti === 'string' && claims.jti.length > 0 && String(claims.run_id) === run.workflow_run_id && String(claims.run_attempt) === '1' && typeof claims.sub === 'string' && claims.sub.startsWith(`repo:${env.GITHUB_REPOSITORY}:`), 403, 'oidc_run_mismatch');
  return claims;
}

export async function isService(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get('authorization') ?? '';
  if (!env.DATA_API_TOKEN || !authorization.startsWith('Bearer ')) return false;
  // Fixed-length digests avoid direct secret-string timing comparisons.
  return await sha256(new TextEncoder().encode(authorization.slice(7))) === await sha256(new TextEncoder().encode(env.DATA_API_TOKEN));
}

export async function authenticate(request: Request, env: Env, runId?: string): Promise<{ ownerId: string; runner: boolean }> {
  if (await isService(request, env)) {
    const ownerId = request.headers.get('x-founder-id');
    requireCondition(ownerId === 'founder', 401, 'founder_required');
    return { ownerId, runner: false };
  }
  requireCondition(runId, 401, 'service_auth_required');
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  requireCondition(token && token.length <= 256, 401, 'runner_auth_required');
  const session = await env.DB.prepare('SELECT s.run_id,s.expires_at,s.workflow_run_id AS session_workflow,r.workflow_run_id AS current_workflow,r.owner_id FROM runner_sessions s JOIN runs r ON r.id=s.run_id WHERE s.token_hash=?').bind(await sha256(new TextEncoder().encode(token))).first<Row>();
  requireCondition(session && session.expires_at > Date.now() && session.run_id === runId && session.session_workflow === session.current_workflow, 401, 'invalid_runner_session');
  return { ownerId: session.owner_id, runner: true };
}

export async function mintSession(env: Env, run: Row, claims: Row): Promise<{ token: string; expiresAt: string }> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
  const expires = Math.min(Date.now() + 900000, claims.exp * 1000, run.expires_at);
  requireCondition(expires > Date.now(), 401, 'expired_oidc');
  try {
    await env.DB.prepare('INSERT INTO runner_sessions(token_hash,run_id,expires_at,oidc_jti,created_at,workflow_run_id) VALUES(?,?,?,?,?,?)')
      .bind(await sha256(new TextEncoder().encode(token)), run.id, expires, claims.jti, Date.now(),run.workflow_run_id).run();
  } catch { throw new HttpError(409, 'oidc_already_exchanged'); }
  return { token, expiresAt: new Date(expires).toISOString() };
}
