# Hardwire data Worker

This Worker is the private data boundary for the founder API and GitHub Actions runner. It owns D1 metadata and private R2 objects. It does not dispatch GitHub workflows or run imported code.

## Local checks and live deployment

From the repository root, after installing the root workspace dependencies:

```sh
npm run test --workspace @hardwire/data-worker
npm run typecheck --workspace @hardwire/data-worker
```

The tests use Node's in-memory SQLite database behind a small D1 interface fixture and an in-memory R2 fixture. They exercise the real migration, route handlers, Web Crypto JWT signature verification, archive parsing and cleanup code. They are not proof of a deployed Cloudflare Worker, actual D1 transaction behavior, R2 persistence, production quotas, or a real elapsed 72-hour retention interval.

## Configuration

Set `DATA_API_TOKEN` as a Worker secret; the founder API must use the same value. Service calls require `Authorization: Bearer <DATA_API_TOKEN>` and `X-Founder-Id: founder`. The founder ID is fixed for this PoC. Keep the token outside the product workspace and logs.

The live Worker is `https://hardwire-data.bernie-web3.workers.dev`. D1 `hardwire` is in APAC with ID `08adc5cc-150e-4365-a9d9-239d52cdcf00`; migration `0001_hardwire.sql` is applied. Private R2 bucket `hardwire-private` is in APAC. `wrangler.jsonc` pins these bindings and trusts `agenticbernie/hardwire` plus the exact `main` workflow ref. The Worker has `*/15 * * * *` cleanup configured. The R2 bucket has not been made public; runtime access uses its private binding.

Set `DATA_API_TOKEN` with `wrangler secret put DATA_API_TOKEN --config apps/data-worker/wrangler.jsonc`, and set the identical value as the Botkeep API secret through its secure configuration UI. This secret is currently unset. Until both locations match, founder service operations are unavailable. Do not use a Worker variable or commit the token to the repository.

## Runner authority

`POST /v1/runner/exchange` takes a GitHub Actions OIDC bearer token and `{runId}`. The Worker obtains signing keys only from GitHub's fixed JWKS endpoint, verifies RS256 signature and issuer/audience/time/repository/workflow/event/run claims, and restricts `run_attempt` to `1`. Product resume dispatches a new workflow; it does not rerun an old GitHub workflow attempt.

Session tokens are cryptographically random, stored only as SHA-256 digests, bound to the product run and current GitHub workflow generation, and expire at the earliest of OIDC expiration, run expiration and 15 minutes. Refresh requires a fresh GitHub OIDC token. Resume revokes earlier sessions. Storage triggers reject stale-generation events/artifacts even when an older request was already in flight.

The runner must keep its session token in the supervisor process; it must not give it to OpenCode, firmware builds, or imported code. Only runner routes can publish evaluator results. A `passed` terminal outcome additionally requires stored passing results and verified identity-matching evidence for every required criterion.

## Storage behavior

- Task revisions are immutable and sequential; approval compares the latest revision and exact approval hash. Criteria have a separate deterministic hash.
- A storage index allows one active run per founder. `(task_id,idempotency_key)` identifies a unique start. Only `created:true` authorizes the API to dispatch a new workflow.
- Workflow attachment is idempotent for the same ID and rejects replacement/reuse. Binding history survives resume until run expiration.
- Events have monotonic sequence numbers and immutable content digests. Exact retries have no repeated usage/state effects; conflicting sequence/content reuse is rejected.
- Artifact bodies are bounded to 32 MiB, compared with declared size and SHA-256 before metadata is committed, and verified again before download. PNG evidence additionally validates chunks/CRC, dimensions, zlib pixels and row filters. The current PNG verifier supports noninterlaced 8-bit grayscale/RGB with optional alpha; unsupported encodings are rejected as evidence.
- A checkpoint becomes recoverable only after its verified artifact is linked by a checkpoint event. Its saved event sequence remains exact even when later heartbeat/usage events arrive. Checkpoint source files are decoded, bounded, path checked and matched to the source tree hash.
- Interrupted runs with a verified checkpoint can resume with a unique API idempotency key. Resume preserves task/attempt/event/usage history, clears the workflow binding and terminal outcome, and installs a bounded 31-minute execution lease (or preserves a longer existing expiry) on the run, project, events and checkpoint artifacts. Terminal finish resets the window to end + retention; ordinary reads and polling do not refresh it.
- Usage sums model step/call/token deltas, keeps cumulative Actions/Wokwi time once per run, and measures artifact bytes from committed metadata. A founder-only `poc_usage_totals` row preserves aggregate measurements and run count after project cleanup; it contains no project/run identifiers or content. `/v1/usage` returns both this PoC lifetime ledger and currently retained per-run rows.
- New runs reserve their approved `maxUsd` against the $10 PoC total measured cost. This blocks a new run when measured historical use plus its approved reservation exceeds the cap. Provider cost is emitted after an inference step, so an in-flight model request may overshoot; this is an admission guard, not a strict billing hard cap.

## Source and archives

An unmaterialized `gunny-snapshot` source returns `404 source_not_materialized` with its pinned commit, so the runner can fetch only the fixed public reference repository at that commit. First export can materialize that exact public snapshot using a fixed codeload URL; there is no caller-controlled fetch URL. Latest verified checkpoint source files replace the exported `source/` files after a run.

Archive imports use the shared manifest schema and check every declared file's digest and size. The ZIP parser bounds compressed/expanded bytes and entry count, rejects traversal, duplicate paths, symlinks, overlapping entries, unsupported encryption/compression and unlisted files, and validates CRCs. Credentials and tool cache paths are excluded. An import creates a new project and a fresh expiration window; original task/run history is preserved read-only in `import_history` and appears in project detail and later exports. Imported history never becomes a running job or an approved new execution automatically.

Source snapshots are stored separately from downloadable exports so project source cannot retain an expired run's evidence inside an old export. Exports contain only unexpired live runs; their own expiration cannot exceed the earliest included run expiration. Exported source/evidence files preserve checksums. All object downloads pass owner, run scope and expiration checks.

## Retention

The default retention interval is 259200 seconds (72 hours). `RETENTION_SECONDS` can shorten it for dedicated validation environments, but cannot lengthen it. Project creation/import establishes the initial project window. Starting or resuming a run installs a bounded active-run lease of at least 31 minutes so cleanup cannot delete an active workflow just before the 30-minute timeout. A qualifying terminal run resets the run and project windows to the session-end time plus the configured retention. Reads, polls and repeated finishes do not refresh it. A shortened-TTL test proves cleanup logic only; the separate elapsed 72-hour observation is still required.

Access is denied at expiration independently of cleanup. The 15-minute cron removes expired run prefixes and related rows even when another run keeps the project alive; it also removes expired exports. Project expiration removes the complete private project prefix, including stranded uploads/imports, and shared metadata. Cleanup records stable error codes, retries with bounded exponential backoff, and measured deletion lag without logging object contents or provider exception messages.

The live D1/R2 bindings, migration, HTTPS Worker deployment and cleanup cron are configured. Remaining prerequisites are the shared API service credential, GitHub repository Actions variables/secrets, a real OIDC dispatch/resume/cancel run, provider quota behavior and a separate real 72-hour retention observation.
