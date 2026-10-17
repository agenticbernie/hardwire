# Hardwire sequential runner

The dispatch workflow accepts only `run_id`. It exchanges GitHub Actions OIDC for a short-lived Worker token, verifies the immutable approval hash, fetches the run's source/checkpoint, and runs these stages sequentially:

1. Restore/fetch only the pinned Gunny snapshot `f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc`, or validate the complete imported `.hardwire.zip` from the Worker.
2. OpenCode implement or repair role; validate actual C/C++ changes against the immutable `src`/`include` boundary and task allowlist.
3. PlatformIO build in an isolated Docker container using the trusted, hashed `platformio.lock.ini`; record logs, BIN/ELF hashes and resolved tools. Firmware binaries remain ephemeral.
4. Wokwi executes the trusted scenario, captures real Serial output and four TFT checkpoints. The source-controlled scenario is **unvalidated** until an authenticated run succeeds.
5. An independent OpenCode evaluator reads current evidence and attached real PNGs; deterministic identity, required-kind, ordered Serial, process completion and PNG gates restrict its criterion proposals.
6. Persist criterion results, issues and checkpoints through the Worker. Repair only evidence-backed product failures, at most three times after the initial attempt.

OpenCode has no shell, delegation, web tools, or write permission during evaluation. Separate containers receive an explicit environment allowlist: OpenCode receives only its provider key; builds receive no provider/simulator/runner/GitHub/Cloudflare credentials; Wokwi receives only its own service token. Containers cannot access the runner's checkout, credentials, Docker socket, or other host directories. Their root filesystem is read-only. Source/checkpoint/evidence bytes never enter GitHub Actions artifacts or caches.

Checkpoints are checksum-verified by the Worker and saved after preparation, guarded agent changes, each successful build, every scenario and each evaluation. Recovery verifies run/approval/source identities, merges authoritative usage/event sequence with checkpoint values, and rebuilds/re-simulates if needed. Terminal runs cannot automatically resume. Cancellation is polled every 15 seconds; SIGTERM/SIGINT and overall time limits also terminate the active container. Abrupt runner loss requires API reconciliation to `interrupted` before an explicitly requested resume.

The workflow and runner both stop within 30 minutes (task limits can reduce this). Each OpenCode call has a three-minute process limit and six measured model steps; a run has at most 24 measured steps and eight calls. Usage is reported after each model step and accumulated across recovery. These are conservative stop limits: an in-flight model request can overshoot a measured dollar threshold. **Exact dollar enforcement remains unproven.** The experimental output-token environment setting is not used as a cap. Runner process time is measured; full billed Actions job duration and provider invoice reconciliation remain unverified.

## Local checks

```sh
node --experimental-strip-types --test apps/runner/test/*.test.ts
./node_modules/.bin/tsc --noEmit -p apps/runner/tsconfig.json
node --experimental-strip-types apps/runner/src/index.ts --check-prerequisites
docker build --tag hardwire-tools:local --file apps/runner/Dockerfile apps/runner
```

The tests exercise safety and runner behavior locally. They do not establish authenticated Wokwi, real Actions OIDC exchange, cloud persistence, cancellation, visual-rubric accuracy, or three complete independent demonstrations.

## Live prerequisites

- A GitHub repository with this exact workflow, OIDC `id-token: write`, and configured Worker repository/workflow/audience trust.
- Repository variables `DATA_WORKER_URL` (HTTPS origin), `HARDWIRE_OIDC_AUDIENCE`; repository secrets `OPENAI_API_KEY`, `WOKWI_CLI_TOKEN`.
- Deployed app Worker, data Worker/D1/private R2, and an approved immutable run attached to the dispatched GitHub workflow run ID before the OIDC exchange. Founder API dispatch/reconciliation requires a valid `GITHUB_PAT` on the app Worker.
- Real authenticated scenario/Serial/TFT observations, seeded behavior/display faults, cancellation and checkpoint recovery, and independent visual-rubric validation.

Missing `WOKWI_CLI_TOKEN` produces `missing_secret` / `blocked_missing_secret` and acceptance `inconclusive`. The runner stops before spending on OpenCode when either required stage credential is absent.
