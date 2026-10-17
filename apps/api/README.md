# Founder API

Node.js 24 and Fastify API for the single-founder Hardwire PoC. Run from the repository with `npm start --workspace @hardwire/api`. The coordinator installs workspace dependencies; this package does not require a separate lockfile.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Exact browser origin, e.g. `https://hardwire.example`; mutations require this Origin header |
| `FOUNDER_PASSWORD_HASH` | `scrypt:<32 lowercase hex salt>:<128 lowercase hex derived key>`; no plaintext password is stored |
| `DATA_WORKER_URL` | Worker HTTPS origin; HTTP is accepted only for localhost development |
| `DATA_API_TOKEN` | At least 32 characters; must match the Worker's server service token |
| `GITHUB_PAT` | Server-only token with Actions write permission for the configured repository |
| `GITHUB_OWNER`, `GITHUB_REPO` | Explicit target repository |
| `GITHUB_WORKFLOW` | Workflow file name; defaults to `hardwire-poc.yml` |
| `GITHUB_REF` | Explicit deployed workflow ref; defaults to `main` |
| `HOST`, `PORT` | Listen address, defaults to `127.0.0.1:3000`; use host `0.0.0.0` when the hosting runtime requires it |

Use the exported `passwordHash()` helper in `src/auth.ts` with an operational secret-input mechanism to provision the password digest. Avoid plaintext passwords in shell history. The API does not print configuration, upstream response bodies, request cookies, authentication headers, or stack traces.

The Worker receives a fixed server-owned founder ID (default `founder`) in `X-Founder-Id`, with `DATA_API_TOKEN` in the Authorization header. These credentials never enter browser responses or workflow dispatch inputs. Build the UI with `npm run build --workspace @hardwire/web` before starting the API; Fastify serves the generated `apps/web/dist` shell and assets from the same origin as `/api`. For local UI development, run Vite and set `HARDWIRE_API_ORIGIN` to the API origin. Browser API calls include credentials; every mutation after login also sends the `x-csrf-token` returned by login/session. Cookies always use Secure, HttpOnly, SameSite=Strict, and the `__Host-` prefix.

## Session and request behavior

`POST /api/auth/login` accepts `{password}`. There is no signup route. `GET /api/auth/session` returns the founder identity, session expiry and CSRF token; `POST /api/auth/logout` revokes the session. Login rotates prior sessions. Sessions expire after eight hours and do not extend on reads.

Sessions and rate-limit buckets are held in this Node process. Run exactly one API process for this PoC. A process restart invalidates sessions; multiple replicas are unsupported until sessions and rate limits use shared storage. Forwarded IP headers are not trusted, so an untrusted client cannot bypass limits by changing `X-Forwarded-For`. A reverse proxy may make users share a rate-limit bucket, which is acceptable for one founder.

Task creation stores an immutable task. `POST /api/tasks/:taskId/revisions` accepts `{objective,allowedPaths,limits,criteria}` and derives the next version from the latest stored task; the Worker rejects racing duplicate revisions. A revision keeps its task ID, computes a fresh approval hash and starts unapproved. Approval requires an exact version/hash match. The task revision loaded for run start supplies the internal criteria hash.

Worker storage atomically claims an idempotency key and enforces one active run before dispatch. Only `created:true` leads to a GitHub dispatch, whose sole input is `run_id`. The API uses GitHub API version `2026-03-10` and persists the returned `workflow_run_id`. It never retries dispatch after a network error, malformed/missing response, or failed identity persistence. The existing run remains `pending_reconciliation`, preserving the active lock. If GitHub returned an identity but persistence failed, the response includes that identity for operator reconciliation. A response lost before the API sees the ID requires operator reconciliation against GitHub; an automatic second dispatch is unsafe.

Cancellation is persisted before calling Actions. The API acknowledges a requested cancellation separately from terminal execution. Polling queries Actions and reconciles terminal cancellation or runner interruption in the Worker. A successful Actions exit alone never supplies acceptance `passed`. The evaluator's acceptance state remains separate.

## Archives and evidence

Import requires a single multipart `file` named `*.hardwire.zip`, limited to 32 MiB. The API checks file framing and forwards bytes to the Worker archive validator. The Worker owns ZIP traversal/symlink/duplicate/expansion checks, manifest and checksum checks, fresh ownership/expiry, and safe storage writes. The API never extracts or executes imports. No successful archive validation is implied by the API's ZIP signature check.

Project list/detail, task revisions and read-only import history come from founder-authorized Worker endpoints. Export returns metadata plus `/api/exports/:id`; artifacts use `/api/artifacts/:id`. Downloads always pass through the Worker's owner/expiry checks, use attachment disposition, suppress active content types, and are never publicly exposed as R2 keys.

Run polling reports execution, acceptance, criteria, attempts, usage, authorized evidence metadata, and workflow status. `/api/usage` returns normalized lifetime totals, currently retained run rows and the $10 admission-budget state. The Worker preserves aggregate metrics and run count after project/run cleanup without retaining content or project/run IDs. New runs reserve their approved `maxUsd` against measured lifetime cost. Responses still state `hardDollarCapVerified:false`: provider usage arrives after model events, so a request already in flight may overshoot the total.

## Verification and remaining live work

`npm test --workspace @hardwire/api` runs Fastify injection tests with stubbed Worker/GitHub HTTP boundaries, including same-origin SPA fallback and asset serving. `npm run build --workspace @hardwire/api` performs scoped TypeScript checking. These are local route/contract tests, not evidence of deployed Worker, D1/R2, Botkeep, GitHub dispatch/cancel, Wokwi execution, or archive round-trip integration. Live work requires configured deployed services, repository/workflow, credentials and real evidence.
