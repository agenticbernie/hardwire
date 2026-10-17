# Hardwire PoC requirements traceability

Source of truth: Hardwire PoC Product & Technical Specification v0.1 (2026-10-17), provided in the user request. Decisions in that source are approved requirements. Status describes current implementation and evidence; a local test does not imply a deployed integration.

## Functional requirements

| Requirement | Implementation component | Task | Acceptance criteria | Evidence | Current status |
|---|---|---:|---|---|---|
| FR-01 Create from pinned snapshot or valid import | API, Worker, runner source loader and archive validator | T02–T04 | AC-15, AC-16 | Pinned commit/tree, source checksum and archive parser tests | Implemented; local source/archive tests. No deployed snapshot/import session. |
| FR-02 Version requests, criteria and approvals | Contracts, API, D1 | T01, T02, T04 | AC-01, AC-13 | Approval hash, stale-version rejection and API route tests | Implemented; local route and Worker fixture tests. |
| FR-03 Identify run/workflow uniquely | API, D1, GitHub Actions | T02, T04 | AC-02 | Run ID, workflow ID and history row | Implemented; local API/Worker tests. No real Actions run. |
| FR-04 Idempotent start/resume | API and Worker | T02, T04 | AC-02, AC-16 | Same-key replay and one dispatch claim tests | Implemented; local duplicate/ambiguous-dispatch tests. No live dispatch. |
| FR-05 Structured coding-agent output | Runner OpenCode adapter | T03 | AC-03, AC-11 | Structured result, changed-file report and usage event | Implemented; CLI/model feasibility call proven. No real firmware edit. |
| FR-06 Build exit/log/firmware hashes | Runner and PlatformIO container | T03 | AC-04 | Exit status, resource use and BIN/ELF hashes | Pinned baseline build proven in runner container and feasibility probe; Actions workflow not executed. |
| FR-07 Wokwi scenario and timeout | Runner and trusted YAML scenario | T03 | AC-05, AC-14 | Scenario hash, process exit/timeout and tool version | Adapter implemented; CLI syntax/lint proven. Authenticated run blocked by absent token. |
| FR-08 Button input and Serial capture | Scenario and runner evidence collector | T03 | AC-05–AC-07 | Input timeline and Serial artifact tied to scenario/code hashes | Implemented but not exercised in Wokwi; no Serial artifact. |
| FR-09 TFT checkpoint capture | Runner screenshot collector and PNG decoder | T03 | AC-08, AC-10 | Four valid PNGs with evidence identity | Implemented and locally checks PNGs; no Wokwi TFT PNG captured. |
| FR-10 Evaluate criteria from evidence | Deterministic gates and OpenCode vision evaluator | T03 | AC-06–AC-10, AC-14 | Per-criterion result, required evidence kinds and identity hashes | Implemented; safety gates tested. Real TFT rubric accuracy not tested. |
| FR-11 Issue record and bounded repair | Runner state machine and repair role | T03 | AC-11, AC-12 | Issue JSON, initial attempt + repair history and stop reason | Implemented; repair-limit/state tests. No live repair run. |
| FR-12 Cancel run | API, Actions and runner signal handling | T03, T04 | AC-16 | Durable cancel request and reconciled terminal state | API/runner logic implemented; API route test only, no live Actions cancellation. |
| FR-13 Verified checkpoints in R2 and run state in D1 | Worker, D1/R2 and runner uploader | T02, T03 | AC-16 | Checksum-verified checkpoint metadata and recovery identity | D1/R2 bindings and migration deployed; no project/checkpoint data or interrupted live-run recovery yet. |
| FR-14 Export/import `.hardwire.zip` | API and Worker archive service | T02, T04 | AC-15, AC-18 | Manifest, checksum round trip and safe-import rejection | Implemented; local archive tests. No live R2 round trip. |
| FR-15 Deny after expiry and delete data | Worker authorizer and scheduled cleanup | T02 | AC-17 | Expiry denial, cleanup records and measured deletion lag | Worker and 15-minute cron deployed; only local shortened-TTL fixture checked. No elapsed 72-hour run or measured remote deletion lag. |
| FR-16 Separate infrastructure/product/inconclusive results | Shared contracts, Worker and runner | T01–T03 | AC-14 | Typed state, outcome and blocker tests | Implemented; local tests ensure missing evidence cannot pass. No live quota/timeout test. |
| FR-17 Per-run and PoC usage | Runner ledger, Worker lifetime ledger, API and UI | T02–T05 | AC-19 | Per-run details plus owner aggregate surviving cleanup; admission check and explicit uncertainty | Implemented locally. Lifetime totals survive run/project cleanup, and each new run reserves its approved `maxUsd`; strict in-flight USD enforcement and billed Actions time remain unverified. |

## Acceptance criteria

| AC | Verification | Evidence expected | Current status |
|---|---|---|---|
| AC-01 Versioned request and criteria approval | Create, approve, revise, and verify approval invalidation | Immutable approval hash/version and local API tests | **Local pass.** API route tests cover stale approval and unapproved revision. |
| AC-02 One workflow per approval/idempotency key | Replay/concurrent start and ambiguous response | One D1 run and one Actions dispatch ID | **Local pass, live unverified.** API/Worker tests cover duplicates and no second dispatch after ambiguity. |
| AC-03 Agent changes timer to 30 seconds | Run approved request against the real pinned project | Guarded diff, source hash, explanation | **Not run.** Model access proven, but no product agent task executed. |
| AC-04 Automated firmware build | Build pinned firmware within Actions runner | Build log, exit code, tool and firmware hashes | **Partially proven.** PlatformIO build ran in the isolated container; GitHub Actions workflow has not run. |
| AC-05 Wokwi scenario and button actions | Authenticated Wokwi run | Scenario result, button timeline, Serial | **Not verified.** No simulation was run; `WOKWI_CLI_TOKEN` was absent in the local probe and GitHub secret configuration is unverified. |
| AC-06 Timeout changes turn | Wait through a full 30-second simulated turn | `TIME UP`, next-player Serial and criterion evidence | **Not run.** Requires Wokwi. |
| AC-07 Angle, power and fire controls | Press each button in scenario | Ordered matching Serial observations | **Not run.** Requires Wokwi. |
| AC-08 TFT screenshots are collected/evaluated | Capture all required checkpoints and run vision rubric | Four valid, identity-bound PNGs and structured criteria | **Not run.** No simulator PNG; image API accepts PNG input, but rubric quality is unverified. |
| AC-09 Seeded behavior defect is detected | Run disposable defective firmware | Correct failed criterion, no false pass | **Not run.** |
| AC-10 Seeded display defect is detected | Run disposable display defect | Correct failed/inconclusive result with screenshot | **Not run.** |
| AC-11 Repair uses evidence-backed issue | Inject a repairable defect and let runner fix | Issue record, repair attempt and diff | **Not run.** |
| AC-12 Stop within repair/budget limits | Force repeat failure, usage threshold, and cumulative run reservation | At most 3 repair rounds and stop reason | **Local logic pass.** Repair/call/token/time limits and the $10 total admission reservation are tested. Provider reports arrive after model events, so an in-flight call can overshoot; the strict dollar hard cap is unverified. |
| AC-13 Agent cannot alter protected files | Attempt protected-path edit | Rejected diff and blocker | **Local pass.** Diff-guard tests reject protected paths/traversal/symlinks. |
| AC-14 Missing evidence/service failure never passes | Remove PNG; force timeout or quota response | `inconclusive`/infrastructure result | **Local logic pass.** Missing-artifact/identity gates and missing-token classification are tested; no live timeout/quota scenario. |
| AC-15 Export/import checksums round-trip | Export/import local test project | Matching source/criteria/evidence checksums | **Local Worker fixture pass.** No deployed R2 round trip. |
| AC-16 Cancel/interruption preserves checkpoint | Cancel/interrupt after a verified checkpoint and resume | Latest checksum-valid checkpoint, preserved history, bounded active lease | **Local logic pass.** Resume extends run/project/evidence expiry to cover the new 30-minute workflow window and keeps history; no live runner termination/recovery. |
| AC-17 Expiry denies access and deletes | Short TTL and separate 72-hour observation | Denial, deletion event and observed lag | **Short-TTL local logic pass only.** No Cloudflare deletion measurement or real 72-hour run. |
| AC-18 Secrets absent from exports/evidence/logs | Secret-canary scan through real run/export | Zero canary matches | **Local controls tested; end-to-end not run.** Archive exclusions and redaction have unit coverage. |
| AC-19 Report measured use and uncertainty | Inspect a product-run report before and after expiry cleanup | Model usage, cost attribution, Actions/Wokwi time, bytes, lifetime total, retained run details | **Partially implemented.** `/api/usage` shape and lifetime cleanup persistence are covered locally; OpenCode cost is not an invoice and an in-flight request can overshoot $10. No full product-run report yet. |
| AC-20 Three independent cloud demonstrations | Complete the standard request three times without manual repair prompts | Three cloud run IDs and evidence sets | **Blocked.** D1/R2, both Workers, migrations, and the shared service secret are deployed. Founder login still needs `FOUNDER_PASSWORD_HASH`; Actions needs a valid app `GITHUB_PAT`, repository variables/secrets, and Wokwi captures. The previously available GitHub REST credential reports account suspension. |

## Evidence identity

Every evidence record carries `run_id`, attempt, test case, source/code, firmware, scenario, and criteria hashes; tool versions; capture time; checksum; byte size; and evidence kind. A criterion cannot pass from a build exit alone. Evidence from a different source or criteria identity cannot support the current run.

The founder-level `poc_usage_totals` ledger retains only aggregate resource metrics and run count after project/run cleanup. It has no project/run IDs or content. New-run admission checks measured lifetime model cost plus the approved session `maxUsd` reservation against the $10 PoC cap; provider usage is reported after inference events, so this does not guarantee a strict in-flight billing ceiling.

## Evidence locations

- PlatformIO and model feasibility outputs: [feasibility record](feasibility.md).
- API, Worker, runner, contract and UI local tests/builds: run commands in the root [README](../../README.md) and each component README.
- Full implementation tasks and current blockers: [implementation plan](../superpowers/plans/2026-10-17-hardwire-poc.md).
- Cloudflare live evidence: D1 migrations `0001` and `0002` applied; R2 bucket `hardwire-private` is private; data Worker version `edc3368a-3f05-4877-a8ec-284b3fe78c61` and app Worker version `084eb22a-be86-4dde-8537-b6b4a6a77b52` deployed. App `/` and `/healthz` returned 200; `/api/usage` returned typed 503 `missing_secret` until founder password configuration. The unauthenticated data endpoint returned `401 service_auth_required`. These checks do not verify authenticated API use, R2 object writes, GitHub OIDC or end-to-end execution.
- Wokwi Serial/screenshots and deployed GitHub Actions runs: not available yet.
