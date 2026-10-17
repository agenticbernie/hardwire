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

## FZ-03 — Botkeep, GitHub Actions, Worker, D1, and R2

**Core Cloudflare path: deployed and smoke-checked. GitHub Actions and Botkeep integration: blocked/unverified.**

- Local Node.js is 24.21.0 and npm is 11.19.0. Wrangler 4.151.1 was run from its ephemeral npx installation; GitHub CLI is absent. PlatformIO and Wokwi were installed only in disposable `/tmp` locations for FZ-01.
- The preconfigured `GITHUB_PAT` returned HTTP 403 for GitHub `/user` and repository Actions APIs with `Sorry. Your account was suspended`. No repository variables or secrets were set and no workflow was dispatched. Its value was not printed.
- After the user approved Wrangler device login, `whoami` authenticated the Cloudflare account. Created D1 `hardwire` (ID `08adc5cc-150e-4365-a9d9-239d52cdcf00`, APAC) and private-by-default R2 bucket `hardwire-private` (APAC). Applied migration `0001_hardwire.sql`; a remote read confirmed the expected application tables and Wrangler reported no pending migrations.
- Deployed Worker `hardwire-data` as version `5042c1b2-bec7-4ebe-8af8-fcff7281de82` at `https://hardwire-data.bernie-web3.workers.dev`, with the D1/R2 bindings and `*/15 * * * *` cleanup cron. An unauthenticated HTTPS request returned the expected `401 service_auth_required`, confirming the Worker endpoint is live. This is not an authenticated API or workflow integration test.
- Worker secret `DATA_API_TOKEN` is not configured because it must also be set as the matching Botkeep API secret through a secure platform configuration. Botkeep deployment/account access is still unverified.
- `OPENAI_API_KEY` exists in the local environment but was not transferred to GitHub; `WOKWI_CLI_TOKEN` is absent. GitHub Actions secret state remains unverified.
- Assuming Botkeep means `botkeep.cloud`, its docs cover Node.js apps and GitHub/ZIP imports. No public programmatic provisioning contract was found, so deployment must use the dashboard or documented import workflow.
- Cloudflare Workers support native D1 and R2 bindings. GitHub documents workflow dispatch and run cancellation; a live dispatch needs a Hardwire repository, workflow, and appropriate Actions write permission.
- No Botkeep, Cloudflare, or GitHub write action was performed during the initial probe. The user later provided [agenticbernie/hardwire](https://github.com/agenticbernie/hardwire); the implementation and dispatch-only workflow were published to `main` at commit `3f783b7`. No workflow dispatch or cloud deployment has occurred.

**Decision:** Cloudflare Worker owns D1/R2 data access. The Botkeep Node process serves founder-facing API and dispatches Actions using a configured GitHub REST integration. Keep Botkeep provisioning manual until its account-specific flow is verified. Use a GitHub OIDC exchange for short-lived runner access rather than putting a permanent Cloudflare credential in the product workspace.

Sources: [Botkeep docs](https://botkeep.cloud/docs), [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/), [Cloudflare bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [GitHub cancellation](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run).

## Open prerequisites

## Current deployment status

- GitHub REST checks using the preconfigured `GITHUB_PAT` returned HTTP 403 with the message `Sorry. Your account was suspended` for both `/user` and the Hardwire repository. The token value was not printed. Repository Actions variables/secrets could not be configured through that token.
- `OPENAI_API_KEY` is present in the execution environment, but was not written to GitHub. `WOKWI_CLI_TOKEN` is absent. GitHub Actions secret configuration remains unverified.
- `apps/data-worker/wrangler.jsonc` has the live D1 ID and trusts `agenticbernie/hardwire` plus the exact `main` workflow ref. This deployment/configuration evidence is included in the current repository handoff update.

| Item | State | Needed to prove |
|---|---|---|
| Cloudflare resources and deployment | D1/R2 provisioned, migration applied, Worker deployed and unauthenticated endpoint smoke-checked | Configure the shared `DATA_API_TOKEN`; validate authenticated API calls and runner OIDC exchange |
| GitHub Actions API credential | REST requests returned 403 suspension message; no repository variables/secrets changed or workflow run dispatched | Restore valid GitHub Actions write access; configure Worker URL/audience variables and runner secrets |
| `WOKWI_CLI_TOKEN` | Absent in the local feasibility environment; repository secret state unverified | Authenticated scenarios, Serial output, TFT screenshots, simulator quota and duration |
| Hardwire GitHub repository and workflow | Workflow published on `main`; OIDC trust configured in deployed Worker, but Actions vars/secrets and dispatch unverified | Live Actions dispatch/cancel and three independent cloud runs |
| Botkeep account/runtime assignment | Unverified | Deployment, host, port/domain and process supervision |
| Worker secret and Botkeep shared credential | Not configured | Same `DATA_API_TOKEN` in Worker secret and Botkeep API secret; authenticated API smoke test |
| D1/R2 checkpoint persistence | Bindings are live; no project/checkpoint data written | Real authorized upload/download/checksum and cleanup validation |
| 72-hour elapsed retention run | Not started | Actual 72-hour operational deletion evidence |
| Visual rubric quality | Not evaluated | Correct detections across real baseline and seeded display failures |
