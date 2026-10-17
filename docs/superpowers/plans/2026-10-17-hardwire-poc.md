# Hardwire PoC Implementation Plan

> **For agentic workers:** Work by task with explicit file ownership, review each output, and preserve the acceptance criteria from the user-provided spec.

**Goal:** Build and verify the first Hardwire PoC loop for a pinned Gunny Arcade ESP32 project, from approved request through agent changes, firmware build, Wokwi evidence, evaluation, repair, and result reporting.

**Architecture:** A React/Vite founder UI is served as Cloudflare Worker Assets. A Cloudflare Worker hosts the founder API through a native Fetch API adapter; a separate Cloudflare Worker owns product D1/R2 operations and expiration. A single GitHub Actions run executes OpenCode, PlatformIO, Wokwi, evidence evaluation, and bounded repairs sequentially. Shared TypeScript contracts define state and evidence across these services.

**Tech Stack:** Node.js 24, TypeScript, React, Vite, Fastify, Cloudflare Workers/D1/R2, GitHub Actions, OpenCode CLI 1.18.34 (pin after compatibility check), PlatformIO Core 6.2.0 for the baseline, Wokwi CLI 0.28.1, Zod, Vitest.

**Spec:** Hardwire PoC Product & Technical Specification v0.1 supplied in the user request (2026-10-17); detailed mapping is in `docs/hardwire/traceability.md` and measured feasibility is in `docs/hardwire/feasibility.md`.

## Global Constraints

- One founder account; one product task runs at a time.
- A run requires an immutable approved request/criteria version and idempotency key.
- Interrupted runs with a verified checkpoint can be resumed idempotently as a new Actions workflow; this remains one product run and one active task. Resume installs a bounded active lease, then terminal finish restores end + retention.
- One implementation attempt, at most three repair rounds, and a 30-minute overall workflow timeout.
- A Wokwi scenario has a maximum of 120 simulation seconds and a separate process timeout.
- PoC OpenAI budget: $10 total; target $1 per session. New runs reserve their approved `maxUsd` against the persistent measured total; an in-flight model call can still overshoot because provider usage arrives after inference.
- Projects expire 72 hours after the latest qualifying session end; polling/viewing does not extend expiry.
- Artifacts are private. Agent changes cannot touch workflow, auth, evaluator, approved criteria, accepted baselines, or budget limits.
- Missing evidence, timeout, missing secret, quota errors, or mismatched hashes cannot produce a pass.
- Do not commit or publish Gunny Arcade product source. Fetch the pinned public snapshot into an isolated ephemeral runner workspace.
- Never put secrets in project code, cache, evidence, logs, or `.hardwire.zip`.
- Do not claim a Cloudflare/Botkeep/GitHub deployment until it has actually been performed and measured.

## Survey and contract

The workspace began empty and without Git metadata. A parent `AGENTS.md` requires a context bootstrap; `process/context/all-context.md` is created with the facts known at project start and must be refreshed as implementation lands.

FZ-01 proves the unchanged Gunny Arcade snapshot builds with PlatformIO. Wokwi CLI syntax and diagram lint are proven, but authenticated simulation and screenshot are blocked by missing `WOKWI_CLI_TOKEN`.

FZ-02 proves `gpt-6-luna` direct API access and one real OpenCode headless call. OpenCode reported actual token usage and cost. A 16-token experimental setting did not bound a multi-step session, so the implementation must measure usage after each model event and stop the session when the configured budget is reached; a strict cost ceiling remains unproven.

FZ-03 now includes live Cloudflare deployment evidence: D1/R2 were provisioned, migrations 0001/0002 were applied, the data Worker plus cleanup cron deployed and returned the expected unauthenticated 401, and the shared service secret was configured on both Workers. The app Worker and UI are also deployed (FZ-04). Founder login, GitHub Actions configuration/dispatch, and authenticated workload remain unverified. The previously configured GitHub REST token is rejected with an account-suspended 403.

## Execution status — 2026-10-17

Hosting follow-up approved by the founder: replace Botkeep with a Cloudflare app Worker because Botkeep reached capacity. The implementation introduces `apps/api/src/worker.ts`, Worker Assets routing, D1-backed founder session/rate-limit state, and migration `0002_founder_auth.sql`. Local Wrangler dry-run and Worker auth smoke checks passed. Remote migration 0002 and deployment have since completed; UI/health are live, while authenticated requests await `FOUNDER_PASSWORD_HASH`.

- T00–T05 implementation is present in the workspace. Contracts, API, Worker/migration, sequential runner/workflow, and founder UI have local checks; the API now serves the built UI from the same origin.
- Root integration follow-ups fixed API resume dispatch semantics, Worker active/resumed-run retention leases, persistent PoC usage and budget admission, per-run attempt history, usage response normalization, cross-service project-detail shape handling, and runner rejected-diff checkpoint safety.
- Pinned PlatformIO baseline was built locally and inside the isolated runner container. OpenCode/model feasibility calls succeeded. Cloudflare D1/R2 and both Workers are deployed and smoke-checked, but authenticated Wokwi, real TFT evidence, founder login, GitHub Actions dispatch, full repair run, and cloud acceptance demonstrations remain unverified or blocked as detailed in the feasibility record.
- T06 local integration is complete: final workspace tests/typecheck/build and post-build same-origin API smoke pass, requirements traceability and handoff docs are refreshed, and independent cross-component review found no remaining actionable local issue. Cloud/Wokwi-dependent ACs remain blocked or unverified and must not be recorded as passes.

### Shared API and data contract

- Execution states: `queued`, `preparing`, `coding`, `building`, `simulating`, `evaluating`, `repairing`, `needs_decision`, `completed`, `failed`, `cancelled`, `interrupted`.
- Acceptance outcome is independent: `passed`, `failed`, `inconclusive`.
- Every state/result event carries `run_id`, monotonic event sequence, timestamp, and source component. Duplicate or stale events are ignored.
- D1 entities: `projects`, `tasks`, `criteria`, `runs`, `attempts`, `test_results`, `artifacts`, `events`, `usage`, founder-only aggregate `poc_usage_totals`, `exports`.
- D1 enforces one active run per founder and a unique `(task_id, idempotency_key)`.
- R2 object keys include founder/project/run/attempt scope; objects remain private and are accessible only through authorization-checked Worker routes.
- Runner evidence records include code/tree, firmware, scenario and criteria hashes, tool versions, elapsed times, checksum, and test-case identity.
- GitHub dispatch inputs contain only the `run_id`. Runner bootstrap exchanges GitHub Actions OIDC identity with the Worker for a run-scoped short-lived token; that token is not passed into OpenCode or product build processes.
- The founder approved Cloudflare Workers as the app/API host after Botkeep reached capacity. The app Worker serves the built UI through Worker Assets and routes API requests through native Fetch handlers; no Botkeep provisioning endpoint is assumed.

## Task ownership and sequence

| Task | Owner | Scope | Depends on | Completion evidence | Status |
|---|---|---|---|---|
| T00 — Product map, feasibility and plan | Coordinator | `docs/hardwire/**`, this plan, `process/context/all-context.md` | User spec | Traceability covers FR-01–17 and AC-01–20; actual FZ outputs recorded | Implemented; traceability refreshed with evidence limits |
| T01 — Monorepo and immutable contracts | Coordinator | root package/config, `packages/contracts/**`, schema tests | T00 | TypeScript build; approval/state/event schema checks | Implemented; root checks passed |
| T02 — Data Worker, D1/R2, lifecycle and archives | Data agent | `apps/data-worker/**`, `db/migrations/**` | T01 | Worker fixture tests; migration; checksum/expiry/import safety | Implemented; remote D1 migration and Worker/R2 bindings deployed; authenticated data and object persistence still pending |
| T03 — Runner, OpenCode, build and Wokwi | Runner agent | `apps/runner/**`, `.github/workflows/hardwire-poc.yml` | T01 and FZ-01 | Local safety checks; baseline build; typed missing-token result | Implemented; container and pinned build proven; authenticated simulator pending |
| T04 — Founder API, approval, GitHub dispatch and reconciliation | API agent + coordinator integration | `apps/api/**` | T01, Worker endpoint contract in T02 | Auth, idempotency, resume, dispatch/cancel and typed outcomes | Implemented; 25 local tests and post-build same-origin UI smoke passed; live dispatch pending |
| T05 — UI | UI agent | `apps/web/**` | T01 and API shape in T04 | Project, approval, run/result/evidence, export/import | Implemented; production build and UI tests passed |
| T06 — System integration and acceptance report | Coordinator + independent reviewer | Root checks, integration configs, docs/evidence | T02–T05 | Interface alignment, full local checks and FR/AC evidence statuses | Local integration complete: 71 tests, typecheck/build, post-build same-origin smoke, independent review found no local issue; live blockers documented |

No agent edits another task's files. T01 defines contracts before implementation agents start. Any interface change is agreed in the shared package/docs and coordinated before edits.

## Verification sequence

1. T01: add contract tests first, observe expected failures, implement minimum Zod/types and hashing helpers, then run `npm run test --workspace @hardwire/contracts` and `npm run typecheck`.
2. T02: exercise Worker handlers against local D1/R2 bindings; verify access/expiry checks, atomic idempotency, archive traversal/symlink/size rejection, checksums, and deletion retry state.
3. T03: rerun the pinned baseline build; validate command exit/timeouts, log filtering, evidence hashes, scenario parser and missing-token classification. With no `WOKWI_CLI_TOKEN`, report simulation/Serial/screenshot as blocked, not passed.
4. T04: exercise API requests for unauthorized access, criterion mutation after approval, repeated idempotency key, a concurrent-run attempt, cancellation, resume after verified interruption, stale events, and usage reporting. Mock only the GitHub HTTP boundary in unit tests; a mock is not live integration proof.
5. T05: build UI and verify project/import, approval version, live run state, evidence/result distinctions, usage, export/import affordances and expiry display.
6. T06: run all tests/build checks, inspect agent diffs/files, compare each FR/AC to traceability and evidence. Run live GitHub/Cloudflare/Wokwi actions only where credentials and target resources are configured; never claim unrun acceptance criteria.
7. After credentials are configured: baseline simulation, seeded behavior/display faults, recovery/export/import, short-TTL cleanup, a separate 72-hour deletion observation, then three independent demo runs.

## File map

- `packages/contracts/src/` — shared request, state, event, evidence, and archive schemas.
- `apps/api/src/` — founder session auth, request/approval/run/cancel/export routes, workflow dispatch and polling.
- `apps/data-worker/src/` — public/internal authorization, D1/R2 bindings, checkpoint/artifact operations, cleanup and archive endpoints.
- `apps/runner/src/` — source preparation, OpenCode adapter and usage parser, diff guard, PlatformIO/Wokwi subprocesses, deterministic evaluation, repair loop and checkpoints.
- `apps/runner/scenarios/` — source-controlled scenarios, explicitly marked unvalidated until Wokwi executes them.
- `.github/workflows/hardwire-poc.yml` — dispatch-only workflow with minimal permissions, 30-minute timeout, pinned tools and no product-source Actions artifacts.
- `apps/web/src/` — founder-only project, approval, run/evidence, result and archive screens.
- `db/migrations/` — D1 tables and constraints.
- `docs/hardwire/` — traceability, feasibility, configuration and deployment evidence.

## Current execution record

The implementation is present in the supplied [agenticbernie/hardwire](https://github.com/agenticbernie/hardwire) project workspace; the current local workspace has no Git metadata. This handoff update records live binding and deployment evidence. Cloudflare D1 `hardwire` (APAC, `08adc5cc-150e-4365-a9d9-239d52cdcf00`), private R2 bucket `hardwire-private`, migrations `0001_hardwire.sql` and `0002_founder_auth.sql`, and both Workers are live. Data Worker version `edc3368a-3f05-4877-a8ec-284b3fe78c61` serves `https://hardwire-data.bernie-web3.workers.dev`; app Worker version `084eb22a-be86-4dde-8537-b6b4a6a77b52` serves `https://hardwire-app.bernie-web3.workers.dev`. The shared `DATA_API_TOKEN` is configured on both Workers. Data unauthenticated smoke returned `401 service_auth_required`; app `/` and `/healthz` returned 200, while `/api/usage` returned typed `503 missing_secret` because `FOUNDER_PASSWORD_HASH` is not yet configured. No GitHub Actions run has been dispatched. The preconfigured `GITHUB_PAT` REST request returned 403 `Sorry. Your account was suspended`; no Actions variables/secrets were changed. `WOKWI_CLI_TOKEN` is absent from the local environment.

At the time of the initial implementation record, local component evidence was contracts 5/5, API 25/25, Worker 18/18, runner 17/17, and UI 6/6 (71/71 total). Subsequent app Worker work added D1 auth-store coverage; see current verification output and the feasibility record for the latest totals. Root checks and the isolated runner Docker image/pinned PlatformIO baseline build passed. These checks do not claim Wokwi or deployed-service acceptance.
