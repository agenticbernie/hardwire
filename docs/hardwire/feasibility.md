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

**Documented architecture: feasible. Live account permissions and deploy: unverified.**

- Local Node.js is 24.21.0 and npm is 11.19.0. GitHub CLI, Wrangler, PlatformIO, and Wokwi CLI were not installed globally; PlatformIO and Wokwi were installed only in disposable `/tmp` locations for FZ-01.
- A `GITHUB_PAT` variable is present, but its value, identity, permissions, and target-repository access were not inspected. The workspace has no GitHub repository or workflow to dispatch.
- Wrangler is absent. A local Wrangler OAuth config exists and contains token-related keys, but values, expiry, identity, and permissions were not inspected. No Cloudflare resource was deployed.
- Assuming Botkeep means `botkeep.cloud`, its docs cover Node.js apps and GitHub/ZIP imports. No public programmatic provisioning contract was found, so deployment must use the dashboard or documented import workflow.
- Cloudflare Workers support native D1 and R2 bindings. GitHub documents workflow dispatch and run cancellation; a live dispatch needs a Hardwire repository, workflow, and appropriate Actions write permission.
- No Botkeep, Cloudflare, or GitHub write action was performed.

**Decision:** Cloudflare Worker owns D1/R2 data access. The Botkeep Node process serves founder-facing API and dispatches Actions using a configured GitHub REST integration. Keep Botkeep provisioning manual until its account-specific flow is verified. Use a GitHub OIDC exchange for short-lived runner access rather than putting a permanent Cloudflare credential in the product workspace.

Sources: [Botkeep docs](https://botkeep.cloud/docs), [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/), [Cloudflare bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [GitHub cancellation](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run).

## Open prerequisites

| Item | State | Needed to prove |
|---|---|---|
| `WOKWI_CLI_TOKEN` | Absent | Authenticated scenarios, Serial output, TFT screenshots, simulator quota and duration |
| Hardwire GitHub repository and workflow | Absent | Live Actions dispatch/cancel and three independent cloud runs |
| Botkeep account/runtime assignment | Unverified | Deployment, host, port/domain and process supervision |
| Cloudflare deploy identity and D1/R2 resources | Unverified | Live Worker deploy, data persistence and deletion behavior |
| 72-hour elapsed retention run | Not started | Actual 72-hour operational deletion evidence |
| Visual rubric quality | Not evaluated | Correct detections across real baseline and seeded display failures |
