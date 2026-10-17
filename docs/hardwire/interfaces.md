# Hardwire PoC interface contract

This contract is owned by the coordinator. Implementation agents consume it read-only. Change it only with a corresponding update to `packages/contracts` and the traceability matrix.

## Result and execution states

Execution state is independent from acceptance outcome.

- `ExecutionState`: `queued | preparing | coding | building | simulating | evaluating | repairing | needs_decision | completed | failed | cancelled | interrupted`.
- `AcceptanceOutcome`: `passed | failed | inconclusive`.
- `CriterionOutcome`: `passed | failed | inconclusive`.
- Infrastructure blockers include `missing_secret`, `service_unavailable`, `quota_exhausted`, `timeout`, `runner_lost`, and `invalid_evidence`.
- Only the evaluator may set an acceptance outcome. A successful process exit is not an acceptance outcome.

## API routes

Founder API (native Fetch API Cloudflare Worker adapter; Fastify Node adapter remains available for local use):

| Method and path | Request | Response / behavior |
|---|---|---|
| `POST /api/projects` | `{name, source:{kind:"gunny-snapshot", commit} }` | New founder-owned project and expiry |
| `GET /api/projects` | none | Founder-owned project list with expiry, source type and latest run summary |
| `GET /api/projects/:projectId` | none | Project detail with task/run history, imported archive history and expiry |
| `POST /api/projects/import` | `multipart/form-data` `.hardwire.zip` | Validated new project; never executes imported code |
| `POST /api/projects/:projectId/tasks` | `{version, objective, allowedPaths, limits, criteria[]}` | Immutable task version and calculated approval hash |
| `POST /api/tasks/:taskId/approve` | `{version, approvalHash}` | Approve only if version/hash still match |
| `POST /api/tasks/:taskId/runs` | `{version, approvalHash, idempotencyKey}` | Existing matching run or one new queued run; reject stale approval and concurrent run |
| `GET /api/runs/:runId` | none | State, outcome, usage, attempt/criterion summary and authorized evidence metadata |
| `POST /api/runs/:runId/cancel` | none | Request cancellation; reconcile asynchronous Actions cancellation |
| `POST /api/runs/:runId/resume` | `{idempotencyKey}` | Resume an interrupted run from its latest verified checkpoint, dispatching one new workflow at most |
| `GET /api/artifacts/:artifactId` | none | Stream/download after owner and expiry checks |
| `POST /api/projects/:projectId/export` | none | Export job/status and a signed/authorized download route |

The founder API Worker holds a server-only `DATA_API_TOKEN`; it sends `Authorization: Bearer <DATA_API_TOKEN>` and `X-Founder-Id: founder` to the data Worker. The data Worker accepts `X-Founder-Id` only with that service token. The founder ID is fixed server configuration for this single-founder PoC and is never accepted from browser input. Browser sessions use the API's secure, HTTP-only cookie and CSRF protection. On Cloudflare, session hashes and rate-limit bucket hashes are stored in D1 so requests can safely reach different Worker isolates.

Data Worker routes, accessible only to the founder API or a validated runner token:

| Method and path | Caller | Contract |
|---|---|---|
| `POST /v1/projects` | API | Create project metadata and initial expiry |
| `GET /v1/projects` | API | List unexpired founder-owned projects and latest run summaries |
| `GET /v1/projects/:id` | API | Return project, current task/run summaries, and preserved imported history |
| `GET /v1/runs/:id/source` | runner | Stream the run's project's materialized `.hardwire.zip`; baseline-only project may return `source_not_materialized` with its pinned commit |
| `GET /v1/artifacts/:id` | API | Stream one private artifact after founder and expiry checks |
| `POST /v1/projects/import` | API | Validate archive and create a new project from its source/history/evidence |
| `POST /v1/tasks` | API | Insert task revision and criteria atomically |
| `GET /v1/tasks/:id` | API | Return task, approved material/hash and criteria hash after owner/expiry checks |
| `POST /v1/tasks/:id/approve` | API | Compare-and-set approval hash/version |
| `POST /v1/runs` | API | Unique idempotency and one-active-run transaction; insert before dispatch |
| `POST /v1/runs/:id/workflow` | API | Attach the GitHub Actions run ID/URL after successful dispatch; repeat with the same ID is idempotent, a different ID is rejected |
| `GET /v1/runs/:id` | API | Return founder-owned run, current state/outcome, usage, criteria, and authorized artifact metadata |
| `GET /v1/usage` | API | Return lifetime aggregate totals, retained per-run breakdown, and $10 run-admission budget status |
| `POST /v1/runs/:id/cancel` | API | Set a durable cancellation request; runner checks it at safe boundaries |
| `POST /v1/runs/:id/resume` | API | Idempotently transition an interrupted run with a verified checkpoint back to queued; retain workflow history and reject cancelled/completed runs |
| `POST /v1/runs/:id/reconcile` | API | Reconcile a terminal GitHub workflow result after querying GitHub; does not infer acceptance pass |
| `POST /v1/runs/:id/events` | runner | Monotonic `seq`; reject mismatched run token; duplicate/stale events are idempotent |
| `POST /v1/runs/:id/artifacts` | runner | Binary request body and JSON metadata in `X-Artifact-Metadata`; stream to private R2, verify size/SHA-256, then insert D1 metadata |
| `GET /v1/runs/:id/checkpoint` | runner | Return latest checksum-verified checkpoint bytes; checksum and sequence in response headers |
| `POST /v1/runs/:id/finish` | runner | Save terminal execution/outcome independently and set expiration |
| `GET /v1/exports/:id` | API | Stream a completed private `.hardwire.zip` after founder and expiry checks |
| `POST /v1/runner/exchange` | runner bootstrap | Validate GitHub Actions OIDC issuer/audience/repository/workflow/run claims; mint short-lived run-scoped token |
| `POST /v1/exports` / `POST /v1/imports` | API | Check manifest/checksum and zip safety before object and metadata writes |

The internal route table is a logical interface; implementations may group routes only if method, authentication scope, atomicity, and data behavior remain equivalent.

### Internal request contracts and authentication

- API-to-Worker requests use `Authorization: Bearer <DATA_API_TOKEN>` plus `X-Founder-Id: founder`. The Worker service token is independent of runner tokens. Do not log either header.
- `POST /v1/runs` body: `{ "taskId": string, "taskVersion": number, "approvalHash": sha256, "criteriaHash": sha256, "idempotencyKey": string }`; project/owner are resolved from the approved task, not trusted from request fields. Response includes `{ "runId": string, "executionState": "queued", "created": boolean }`.
- `POST /v1/runs/:id/workflow` body: `{ "workflowRunId": string, "workflowUrl": string }`. Repeating the same workflow ID is safe; replacing it is a conflict.
- `GET /v1/tasks/:id` returns `{ "taskId", "projectId", "version", "objective", "allowedPaths", "limits", "criteria", "approvalHash", "criteriaHash", "approvedAt" }`; the API uses this to construct a run request without process-local state.
- Runner bootstrap obtains a GitHub Actions OIDC token for the configured Worker audience and calls `POST /v1/runner/exchange` with `Authorization: Bearer <github-oidc-token>` and body `{ "runId": string }`. The Worker validates signature and claims (`iss`, `aud`, `exp`, `repository`, `workflow_ref`, `run_id`, `run_attempt`) against the exact configured repository/workflow and stored run. It returns `{ "token": string, "expiresAt": ISO-8601, "run": { "runId", "projectId", "taskId", "approvalMaterial", "approvalHash", "criteriaHash", "cancellationRequested" } }` only after validation.
- Runner calls use `Authorization: Bearer <short-lived-run-token>`; the Worker derives `runId` from token claims and also checks that the path ID matches. This token is not passed to OpenCode or product build processes.
- Event body uses the envelope below. Artifact uploads send raw bytes; `X-Artifact-Metadata` is JSON for identity, kind, tool versions, byte size, SHA-256, media type, and capture time. Metadata must agree with actual bytes and the run's approved task hashes.
- `GET /v1/runs/:id` with a run token returns run control and approved material for runner recovery. A checkpoint GET returns bytes with `X-Artifact-SHA256`, `X-Checkpoint-Sequence`, and `Content-Type`; an empty response means no verified checkpoint exists.
- `POST /v1/runs/:id/finish` body: `{ "executionState": "completed"|"failed"|"cancelled"|"interrupted", "acceptanceOutcome": "passed"|"failed"|"inconclusive", "summary": string }`. Infrastructure failures must not be translated into acceptance `passed`.
- Resume body is `{ "idempotencyKey": string }`. Only an `interrupted` run with a non-expired, checksum-verified checkpoint may resume. A successful resume clears only terminal execution fields/current workflow binding; it keeps the run ID, approved task, prior artifacts, event sequence, and repair attempt, and extends the run/project/evidence lease to at least 31 minutes while preserving a longer existing expiry. Terminal finish resets the window to end + retention. The next Actions workflow is dispatched once and recorded in workflow history. Repeated keys return the same queued run without dispatching again.
- For a baseline project whose source archive has not yet been materialized, `GET /v1/runs/:id/source` responds 404 `{ "code": "source_not_materialized", "sourceCommit": "<pinned commit>" }`. The runner may then clone only the fixed Gunny Arcade repository at exactly that commit. Imported projects must always provide their stored archive and may never use this fallback.
- `POST /v1/runs/:id/reconcile` body includes GitHub's terminal workflow conclusion and completion time, observed by the API from GitHub rather than user input. It can close an infrastructure/workflow failure but cannot mark product acceptance `passed`.

### Archive format v1

`.hardwire.zip` has `manifest.json` at ZIP root with `{ "format": "hardwire-archive", "formatVersion": 1, "createdAt": ISO-8601, "project": { "name": string, "sourceCommit": string|null }, "tasks": [], "runs": [], "files": [{ "path": string, "byteSize": number, "sha256": string, "mediaType": string }] }`. Task history preserves version, objective, allowed paths, limits, approval hash/time, and criteria. Run history preserves execution/outcome, times, attempts, usage and criterion results with their evidence identities. Run artifact/checkpoint entries refer to a `path` in `files`; all source, artifact, log, screenshot, and checkpoint bytes are stored as listed files. The manifest does not list itself. Paths are normalized relative paths with no duplicates; every listed file must exist once and match exact byte size and digest, and every non-manifest file must be listed. ZIP handling enforces compressed and expanded size/count limits, rejects traversal, absolute paths, duplicate normalized paths, symlinks and unsupported entries, and never runs imported code. Import assigns a fresh project ID and starts a new expiry window; credentials and tool caches are excluded.

## Runner event envelope

```json
{
  "eventId": "uuid",
  "runId": "uuid",
  "sequence": 12,
  "occurredAt": "ISO-8601 UTC",
  "type": "state|checkpoint|usage|artifact|criterion|issue|heartbeat|terminal",
  "payload": {}
}
```

The Worker accepts event sequence numbers once, rejects a reused sequence with different content, and ignores exact duplicate event IDs. Event payloads never include credentials or full source content.

## Evidence identity and artifact metadata

Every evidence record includes: `runId`, `attempt`, `testCaseId`, `sourceHash`, `firmwareHash`, `scenarioHash`, `criteriaHash`, `toolVersions`, `capturedAt`, `sha256`, `byteSize`, `mediaType`, and evidence kind. Logs are redacted before upload. Screenshot validity requires an actual decodable PNG; absence or hash mismatch means `inconclusive`.

The lifetime usage ledger is owner-scoped and contains aggregate token, cost, time, artifact-byte and run-count values only. It survives project/run cleanup but stores no content or project/run IDs. Before a new run, the Worker requires measured lifetime cost plus the approved task `maxUsd` reservation to be at most `$10`. Since model cost arrives after inference usage events, this is a start-admission guard and cannot prevent an in-flight request from overshooting.

## D1 invariants

- One active run per founder (PoC has one founder) enforced in storage, not only in API memory.
- Unique `(task_id, idempotency_key)` maps retries to the same run.
- Approval is immutable and matched against task version plus criteria hash before dispatch.
- `runs.execution_state` and `runs.acceptance_outcome` are separate columns.
- Each event and artifact belongs to a project/run owner and is denied when `expires_at <= now`.
- Expiration is set by a qualifying run end/import creation; read/poll operations never extend it.
