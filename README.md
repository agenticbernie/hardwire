# HARDWIRE

Founder-only PoC for the approved Hardwire specification. The app has one Fastify service for the founder UI/API, one Cloudflare Worker for private D1/R2 operations, and one sequential GitHub Actions runner for OpenCode, PlatformIO, Wokwi and evidence evaluation.

The product repo was scaffolded in a workspace without Git metadata. The reference Gunny Arcade source stays pinned to commit `f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc` and is fetched into the runner's disposable source directory; it is not committed here.

## Local build and checks

Requirements: Node.js 24.x and npm. From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm run build` compiles the web UI into `apps/web/dist` and typechecks the API and runner. The API serves that UI and `/api` from the same origin. To run the API locally, configure the founder and Worker environment variables below, then run:

```sh
npm start --workspace @hardwire/api
```

For UI development, run `npm run dev --workspace @hardwire/web`; set `HARDWIRE_API_ORIGIN` to the API origin so Vite proxies `/api`. The API requires HTTPS origins except for localhost. No credentials are committed in an `.env` file.

Run a single component check with `npm test --workspace @hardwire/api`, `npm test --workspace @hardwire/data-worker`, `npm test --workspace @hardwire/runner`, or `npm test --workspace @hardwire/web`.

## Runtime configuration

Configure values through each platform's secret/environment manager. Do not paste credentials into source, issue logs, Actions inputs, or this document.

| Component | Variable | Type / purpose |
|---|---|---|
| Botkeep API | `PUBLIC_ORIGIN` | Exact public HTTPS origin for the founder UI and API |
| Botkeep API | `FOUNDER_PASSWORD_HASH` | Scrypt digest in the format documented in `apps/api/README.md`; never a plaintext password |
| Botkeep API | `DATA_WORKER_URL`, `DATA_API_TOKEN` | Worker HTTPS origin and shared server-only service secret (minimum 32 characters) |
| Botkeep API | `GITHUB_PAT` | Server-only fine-grained GitHub token with Actions read/write on the Hardwire repository |
| Botkeep API | `GITHUB_OWNER`, `GITHUB_REPO` | Exact repository containing this project/workflow |
| Botkeep API | `GITHUB_WORKFLOW`, `GITHUB_REF` | Defaults: `hardwire-poc.yml`, `main` |
| Botkeep API | `HOST`, `PORT` | Bind address and platform port; hosted runtime generally needs `0.0.0.0` |
| Cloudflare Worker | `DATA_API_TOKEN` | Worker secret matching the API value |
| Cloudflare Worker | `GITHUB_REPOSITORY` | Exact `owner/repository` trusted for runner OIDC |
| Cloudflare Worker | `GITHUB_WORKFLOW_REF` | Exact workflow ref, e.g. `owner/repository/.github/workflows/hardwire-poc.yml@refs/heads/main` |
| Cloudflare Worker | `OIDC_AUDIENCE` | Exact audience configured in Worker and GitHub Actions variable |
| Cloudflare Worker | `RETENTION_SECONDS` | Defaults to `259200` (72 hours); may be shortened only in a dedicated validation environment |
| GitHub repository variable | `DATA_WORKER_URL` | Deployed Worker HTTPS origin |
| GitHub repository variable | `HARDWIRE_OIDC_AUDIENCE` | Must equal the Worker `OIDC_AUDIENCE` |
| GitHub repository secrets | `OPENAI_API_KEY`, `WOKWI_CLI_TOKEN` | Separate credentials for the OpenCode and Wokwi containers |

The model feasibility probe used the exact model ID `gpt-6-luna`. The runner uses OpenCode's configured provider; model routing must be configured and rechecked in the runner image before live runs. The Worker keeps an owner-level aggregate usage ledger after run/project expiry and admits a new run only when measured PoC spend plus its approved `maxUsd` reservation stays at or below $10. Current cost is provider/OpenCode usage data, not an invoice; a model request already in flight can overshoot before its usage event arrives, so this is not a strict billing cap.

## Deployment order

Cloudflare resources and the data Worker are now deployed. The founder API/Botkeep integration and GitHub Actions credentials remain pending.

1. **Finish GitHub Actions configuration.** The workflow is published at [agenticbernie/hardwire](https://github.com/agenticbernie/hardwire), branch `main`, and is dispatch-only. The Cloudflare Worker already trusts this repo/workflow. Configure repository variables `DATA_WORKER_URL=https://hardwire-data.bernie-web3.workers.dev` and `HARDWIRE_OIDC_AUDIENCE=hardwire-data`, then secrets `OPENAI_API_KEY` and `WOKWI_CLI_TOKEN`. No run has been dispatched because the available GitHub REST credential returned HTTP 403 (`Your account was suspended`), and the Wokwi secret is not available in this environment. Do not add product source or evidence to Actions artifacts/cache uploads.
2. **Cloudflare state already deployed.** D1 `hardwire` (APAC, ID `08adc5cc-150e-4365-a9d9-239d52cdcf00`) is bound to Worker `hardwire-data`; migration `0001_hardwire.sql` is applied. Private R2 bucket `hardwire-private` (APAC) is bound to `ARTIFACTS`. The Worker is deployed at `https://hardwire-data.bernie-web3.workers.dev` with the `*/15 * * * *` cleanup cron. Remote table/migration checks succeeded, and an unauthenticated HTTPS request returned the expected `401 service_auth_required` response. This does not prove authenticated data operations.
3. **Configure shared service authentication.** Set a matching `DATA_API_TOKEN` using the secure secret managers for Cloudflare Worker and Botkeep API. It must not be put in this repository or chat. It is currently unset, so founder API requests cannot yet use the deployed Worker.
4. **Deploy the API/UI to Botkeep.** Import the GitHub repository through the Botkeep dashboard, set API variables/secrets, use Node.js 24, and configure build `npm ci && npm run build` and start `npm start --workspace @hardwire/api`. Build output is required because Fastify serves `apps/web/dist`. Bind to the hosting-provided port and `0.0.0.0`. Set `PUBLIC_ORIGIN` to the final HTTPS origin. Do not configure a second UI proxy unless it preserves the same-origin cookie/CSRF behavior.
5. **Verify in a disposable project.** Confirm login, authenticated Worker access, task approval, GitHub dispatch, OIDC exchange and cancellation. Then run the baseline Wokwi scenario, validate actual Serial and TFT captures, inject behavior/display defects, and test repair/checkpoints/export/import. The three independent demo runs and a separate elapsed 72-hour cleanup observation are required before declaring PoC acceptance.

To redeploy the Worker after a code/config change, use Wrangler authenticated to the intended account:

```sh
npx wrangler@4.151.1 d1 migrations apply hardwire --remote --config apps/data-worker/wrangler.jsonc
npx wrangler@4.151.1 deploy --config apps/data-worker/wrangler.jsonc
```

D1/R2 contents remain behind Worker ownership, expiry and credential checks; do not enable public bucket access.

## Evidence and limits

- [Feasibility experiments](docs/hardwire/feasibility.md) record actual PlatformIO/model probes and missing live-service proof.
- [FR/AC traceability](docs/hardwire/traceability.md) reports each requirement against local and live evidence.
- [Interface contract](docs/hardwire/interfaces.md) defines API routes, run state, evidence identity and archive format.
- [Implementation plan and execution notes](docs/superpowers/plans/2026-10-17-hardwire-poc.md) record task owners and verification.
- Component security/configuration notes: [API](apps/api/README.md), [Worker](apps/data-worker/README.md), [runner](apps/runner/README.md).

Passing local tests, a baseline firmware build, and successful model probes do not establish authenticated Cloudflare data operations, Wokwi screenshots, Botkeep/GitHub integration, visual-evaluator accuracy, real 72-hour deletion, or the three-run acceptance criterion. Current blockers are summarized in the [feasibility record](docs/hardwire/feasibility.md#open-prerequisites).
