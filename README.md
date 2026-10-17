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

No remote service has been deployed as part of this implementation. Account creation, repository import and deployment must be performed by an operator in the target accounts.

1. **Create the Hardwire GitHub repository.** Import/push this workspace, keep `.github/workflows/hardwire-poc.yml` on the chosen default branch, and confirm the workflow is enabled. The initial workspace has no Git history or remote, so no workflow dispatch can currently be made. Configure the Actions secrets and variables listed above. The workflow requests only `contents: read` and `id-token: write`; do not add product source or evidence to Actions artifact/cache uploads.
2. **Provision Cloudflare.** Create one D1 database and one private R2 bucket. Put the real D1 ID in `apps/data-worker/wrangler.jsonc`; retain the `hardwire-private` bucket name or adjust it to match the provisioned bucket. Set `GITHUB_REPOSITORY`, exact `GITHUB_WORKFLOW_REF`, and `OIDC_AUDIENCE` to match the repository/workflow. Keep `DATA_API_TOKEN` as a Worker secret. The config enables the authenticated Worker API on a `workers.dev` address; a custom domain can be used instead when its route is configured.
3. **Apply the D1 migration and deploy the Worker.** With Wrangler available and authenticated to the intended Cloudflare account, run from the project root:

   ```sh
   npx wrangler d1 migrations apply hardwire --remote --config apps/data-worker/wrangler.jsonc
   npx wrangler deploy --config apps/data-worker/wrangler.jsonc
   ```

   Confirm the deployed HTTPS origin and cron before sharing the origin with Botkeep/GitHub. D1/R2 contents remain behind Worker ownership, expiry and credential checks; do not enable public bucket access.
4. **Deploy the API/UI to Botkeep.** Import the GitHub repository through the Botkeep dashboard, set the API variables/secrets, use Node.js 24, and configure build `npm ci && npm run build` and start `npm start --workspace @hardwire/api`. Build output is required because Fastify serves `apps/web/dist`. Bind to the hosting-provided port and `0.0.0.0`. Set `PUBLIC_ORIGIN` to the final HTTPS origin. Do not configure a second UI proxy unless it preserves the same-origin cookie/CSRF behavior.
5. **Verify in a disposable project.** First confirm `/healthz`, login, task approval, Worker access, GitHub dispatch, OIDC exchange and cancellation. Then run the baseline Wokwi scenario, validate actual Serial and TFT captures, inject behavior/display defects, and test repair/checkpoints/export/import. The three independent demo runs and a separate elapsed 72-hour cleanup observation are still required before declaring PoC acceptance.

## Evidence and limits

- [Feasibility experiments](docs/hardwire/feasibility.md) record actual PlatformIO/model probes and missing live-service proof.
- [FR/AC traceability](docs/hardwire/traceability.md) reports each requirement against local and live evidence.
- [Interface contract](docs/hardwire/interfaces.md) defines API routes, run state, evidence identity and archive format.
- [Implementation plan and execution notes](docs/superpowers/plans/2026-10-17-hardwire-poc.md) record task owners and verification.
- Component security/configuration notes: [API](apps/api/README.md), [Worker](apps/data-worker/README.md), [runner](apps/runner/README.md).

Passing local tests, a baseline firmware build, and successful model probes do not establish authenticated Wokwi screenshots, deployed Cloudflare/Botkeep/GitHub integration, visual-evaluator accuracy, real 72-hour deletion, or the three-run acceptance criterion. Current blockers are summarized in the [feasibility record](docs/hardwire/feasibility.md#open-prerequisites).
