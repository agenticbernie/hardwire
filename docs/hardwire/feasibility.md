# Hardwire PoC feasibility record

**Spec:** Hardwire PoC Product & Technical Specification v0.1, supplied in the user request (2026-10-17).

**Workspace inspected:** `/home/bernieweb3/Downloads/agenticbernie/hardwire`.

**Result:** The workspace was an empty, non-Git directory. The only requirements source available was the complete spec in the conversation.

## FZ-01 — Gunny Arcade, PlatformIO, and Wokwi

**Overall: inconclusive.** The reference build is proven; authenticated simulation and captures are not.

- Reference snapshot: commit `f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc`, tree `11775b2baab2a56d009f9d2d89007961d6d4d2ac`.
- PlatformIO Core 6.2.0 built the unchanged `esp32dev` firmware successfully. RAM use was 22,016 bytes and flash use was 295,201 bytes. Firmware BIN SHA-256: `dac698dcd735d8d7b9ef0bf340fbe9ad902c67411c12e82e44ab43553177565d`.
- Wokwi CLI 0.28.1 is runnable. Its actual help lists scenario YAML, serial logs, component screenshot, screenshot time, and timeout options. Diagram lint exited 0, with an informational notice that the ESP32 diagram part is undocumented.
- Actual CLI simulation and scenario commands exited 1 before contacting the simulator because `WOKWI_CLI_TOKEN` was absent. No Serial capture or TFT PNG exists. The prepared scenario is unvalidated.
- Baseline diagram part IDs: `esp`, `tft`, `btnAngleUp`, `btnAngleDown`, `btnPowerUp`, `btnPowerDown`, `btnFire`. The firmware debounces buttons for 50 ms; allow at least 100 ms for press and release.
- Existing Serial observations include `P1 ANG=46 POW=50 DMG~26`, `FIRE P1 angle=46 power=50 dmg=26`, outcome messages, `TURN P2 75s`, and a winner message. The baseline has no existing automated scenario.
- Full command transcript and additional hashes remain at `/tmp/hardwire-fz01_FEASIBILITY_17-10-26.md`.

**Decision:** implement a real PlatformIO/Wokwi process adapter and label the simulator stage `blocked_missing_secret` until the runner receives `WOKWI_CLI_TOKEN`. Do not turn missing credentials into a product pass/fail, and do not claim serial/screenshot evidence until files are actually produced and validated.

Sources: [Wokwi CLI usage](https://docs.wokwi.com/wokwi-ci/cli-usage), [Wokwi automation scenarios](https://docs.wokwi.com/wokwi-ci/automation-scenarios), [Wokwi CLI installation](https://docs.wokwi.com/wokwi-ci/cli-installation).

## FZ-02 — OpenCode and OpenAI model

**CLI and model inference: feasible. Image evaluation: capability supported, but visual rubric quality is not yet measured.**

- Installed OpenCode is version 1.18.34. Headless server health and OpenAPI endpoints returned HTTP 200; the provider registry reported `openai/gpt-6-luna`, tool calling, and image input.
- A real OpenAI Responses request with `max_output_tokens: 16` completed using model `gpt-6-luna`: HTTP 200, output `OK`, 11 input tokens, 5 output tokens. A request below the API minimum of 16 output tokens returned HTTP 400 and was not billed.
- A real OpenCode headless inference completed on `openai/gpt-6-luna`: output `OK`, 3 input tokens, 5 output tokens, reported session cost `$0.0025743` (the usage record also included 20,572 cache-write tokens).
- A real Responses API request with a generated 2×2 PNG completed on `gpt-6-luna`: HTTP 200, output `IMAGE_OK`, 19 input tokens and 29 output tokens. At the documented standard text rates, the usage-based estimate is `$0.0000164`; it is not an invoice. This proves the API accepted an image input, not that a visual rubric can reliably detect TFT defects.
- One long-output probe with `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=16` did **not** cap the overall OpenCode interaction: the agent invoked a shell tool and reported 1,003 output tokens. Reported cost was `$0.00083971`. Treat this environment variable as unverified for enforcing a hard session cost cap.
- The two OpenCode probes together reported `$0.00341401`; OpenAI direct API usage was 16 text tokens. Current documented standard text price is `$0.10` input / `$0.50` output per million tokens. The direct API probe's price-based estimate is `$0.0000036`; it is an estimate, not an invoice.
- OpenAI documents the exact model ID `gpt-6-luna`, image input, and function calling. An API request with a generated 2×2 PNG was accepted, but no real Wokwi TFT image has been evaluated and visual-rubric accuracy is unverified.

**Decision:** use the pinned OpenCode headless CLI and consume structured usage events. Enforce per-run call/repair/time limits, stop after measured accumulated usage reaches the approved per-run threshold, and reserve approved per-run `maxUsd` against the persistent `$10` PoC total before admitting each new run. Provider usage arrives after inference, so a request already in flight can overshoot; do not claim a hard billing cap. Model image input is API-proven, but keep image criteria `inconclusive` until a real Wokwi TFT PNG and seeded display defect are evaluated.

Sources: [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenAI image guide](https://developers.openai.com/api/docs/guides/images-vision), [OpenCode CLI](https://opencode.ai/docs/cli/), [OpenCode provider configuration](https://docs.opencode.ai/docs/providers/).

## FZ-03 — Cloudflare data Worker, D1/R2, and GitHub Actions

**Cloudflare data plane: deployed. GitHub Actions dispatch: blocked/unverified.**

- Local Node.js is 24.21.0 and npm is 11.19.0. Wrangler 4.151.1 is now pinned in the workspace. PlatformIO and Wokwi were installed only in disposable `/tmp` locations for FZ-01.
- The preconfigured `GITHUB_PAT` returned HTTP 403 for GitHub `/user` and repository Actions APIs with `Sorry. Your account was suspended`. No repository variables or secrets were set and no workflow was dispatched. Its value was not printed.
- D1 `hardwire` (ID `08adc5cc-150e-4365-a9d9-239d52cdcf00`, APAC) and private R2 bucket `hardwire-private` (APAC) are live. Migrations `0001_hardwire.sql` and `0002_founder_auth.sql` are applied remotely.
- Data Worker `hardwire-data` is live at `https://hardwire-data.bernie-web3.workers.dev`, with D1/R2 bindings and the `*/15 * * * *` cleanup cron. The current version is `edc3368a-3f05-4877-a8ec-284b3fe78c61`. An unauthenticated HTTPS request returned the expected `401 service_auth_required`.
- One randomly generated `DATA_API_TOKEN` was set through Wrangler's secret manager on both Cloudflare Workers. Its value was not printed or stored in the repository.
- `OPENAI_API_KEY` exists in the local environment but was not transferred to GitHub; `WOKWI_CLI_TOKEN` is absent. GitHub Actions secret state remains unverified.
- Botkeep was the original hosting target. After the founder reported that it had reached capacity, the founder approved Cloudflare Workers for the app/API while retaining GitHub Actions as the product runner.

**Decision:** Keep `hardwire-data` as the D1/R2 boundary, host founder UI/API on a separate Worker, and run OpenCode/PlatformIO/Wokwi in GitHub Actions. Use a GitHub OIDC exchange for short-lived runner access rather than putting a permanent Cloudflare credential in the product workspace.

Sources: [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/), [Cloudflare bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [GitHub cancellation](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run).

## FZ-04 — Cloudflare founder UI/API Worker

**Worker Assets and native API routing: locally and remotely deployed. Founder login: awaiting a founder password hash.**

- A first attempt to run Fastify behind Cloudflare's Node HTTP adapter failed in local Workerd because Fastify's route compilation uses `new Function`, which the runtime blocks. The API Worker now uses native Fetch `Request`/`Response` routing and reuses the existing auth, service, GitHub, and data-client modules.
- `wrangler deploy --dry-run --config apps/api/wrangler.jsonc` succeeded. The bundle was 814.58 KiB (131.10 KiB gzip) and included the Vite SPA assets, D1 binding, and asset routing.
- Local Wrangler tests against local D1 applied migrations 0001/0002. The Worker served `/` and `/healthz`; login/session/logout returned 200/200/204, and the revoked cookie returned 401. API tests passed 26/26, including D1 session rotation and persistent rate-limit checks.
- Remote migration 0002 was applied, the data Worker was redeployed, and app Worker `hardwire-app` version `084eb22a-be86-4dde-8537-b6b4a6a77b52` was deployed at `https://hardwire-app.bernie-web3.workers.dev`.
- Remote smoke checks returned 200 for `/healthz` and `/`, with the Hardwire shell present. `/api/usage` returned the expected typed 503 `missing_secret` because `FOUNDER_PASSWORD_HASH` is not configured. No founder login or authenticated API request has passed remotely.
- `GITHUB_PAT` is also not configured on the app Worker. Even after founder login is enabled, starting/cancelling Actions runs remains unavailable until a valid repository-scoped GitHub token is supplied.

Sources: [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/), [Cloudflare Node.js HTTP compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/).

## Open prerequisites

## Current deployment status

- GitHub REST checks using the preconfigured `GITHUB_PAT` returned HTTP 403 with the message `Sorry. Your account was suspended` for both `/user` and the Hardwire repository. The token value was not printed. Repository Actions variables/secrets could not be configured through that token.
- `OPENAI_API_KEY` is present in the execution environment, but was not written to GitHub. `WOKWI_CLI_TOKEN` is absent. GitHub Actions secret configuration remains unverified.
- `apps/data-worker/wrangler.jsonc` has the live D1 ID and trusts `agenticbernie/hardwire` plus the exact `main` workflow ref. This deployment/configuration evidence is included in the current repository handoff update.

| Item | State | Needed to prove |
|---|---|---|
| Cloudflare data plane | D1/R2 deployed, both migrations applied, data Worker updated, shared service token configured | Authenticated API calls, runner OIDC exchange, and authorized R2 object persistence |
| Cloudflare founder API/UI | App Worker and static UI deployed; health/root return 200 | Set `FOUNDER_PASSWORD_HASH`, verify login/session and authorized data calls |
| GitHub Actions API credential | REST requests returned 403 suspension message; no repository variables/secrets changed or workflow run dispatched | Restore valid GitHub Actions write access; configure Worker URL/audience variables and runner secrets |
| `WOKWI_CLI_TOKEN` | Absent in the local feasibility environment; repository secret state unverified | Authenticated scenarios, Serial output, TFT screenshots, simulator quota and duration |
| Hardwire GitHub repository and workflow | Workflow published on `main`; OIDC trust configured in deployed Worker, but Actions vars/secrets and dispatch unverified | Live Actions dispatch/cancel and three independent cloud runs |
| D1/R2 checkpoint persistence | Bindings are live; no project/checkpoint data written | Real authorized upload/download/checksum and cleanup validation |
| 72-hour elapsed retention run | Not started | Actual 72-hour operational deletion evidence |
| Visual rubric quality | Not evaluated | Correct detections across real baseline and seeded display failures |
