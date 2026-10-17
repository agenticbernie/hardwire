# HARDWIRE

Founder-only PoC for the approved Hardwire specification. The app has one Cloudflare Worker serving the founder UI/API, one Cloudflare Worker for private D1/R2 product data operations, and one sequential GitHub Actions runner for OpenCode, PlatformIO, Wokwi and evidence evaluation.

The product repo was scaffolded in a workspace without Git metadata. The reference Gunny Arcade source stays pinned to commit `f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc` and is fetched into the runner's disposable source directory; it is not committed here.

## Local build and checks

Requirements: Node.js 24.x and npm. From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm run build` compiles the web UI into `apps/web/dist` and typechecks the API and runner. Cloudflare Worker Assets serves the UI and routes `/api` through the same origin. The shared Hono app runs directly on Workers and through `@hono/node-server` for local Node development. To run the Node adapter, configure the founder and Worker environment variables below, then run:

```sh
npm start --workspace @hardwire/api
```

For UI development, run `npm run dev --workspace @hardwire/web`; set `HARDWIRE_API_ORIGIN` to the API origin so Vite proxies `/api`. The API requires HTTPS origins except for localhost. No credentials are committed in an `.env` file.

Run the API and UI together on local Workers with `npm run dev:cloudflare-app` after configuring `.dev.vars`. Deploy the app Worker with `npm run deploy:cloudflare-app`. Run a single component check with `npm test --workspace @hardwire/api`, `npm test --workspace @hardwire/data-worker`, `npm test --workspace @hardwire/runner`, or `npm test --workspace @hardwire/web`.

## Runtime configuration

Configure values through each platform's secret/environment manager. Do not paste credentials into source, issue logs, Actions inputs, or this document.

| Component | Variable | Type / purpose |
|---|---|---|
| Cloudflare app Worker | `PUBLIC_ORIGIN` | Exact public HTTPS origin for founder UI/API; configured as a non-secret Worker variable |
| Cloudflare app Worker | `FOUNDER_PASSWORD_HASH` | Scrypt digest in the format documented in `apps/api/README.md`; never a plaintext password |
| Cloudflare app Worker | `DATA_WORKER_URL`, `DATA_API_TOKEN` | Data Worker origin and shared server-only service secret (minimum 32 characters) |
| Cloudflare app Worker | `GITHUB_PAT` | Server-only fine-grained GitHub token with Actions read/write on the Hardwire repository |
| Cloudflare app Worker | `GITHUB_OWNER`, `GITHUB_REPO` | Exact repository containing this project/workflow; set as non-secret Worker variables |
| Cloudflare app Worker | `GITHUB_WORKFLOW`, `GITHUB_REF` | Defaults: `hardwire-poc.yml`, `main`; set as non-secret Worker variables |
| Cloudflare app Worker | `AUTH_DB` | D1 binding to `hardwire`, used for durable founder sessions and rate limits |
| Cloudflare data Worker | `DATA_API_TOKEN` | Worker secret matching the app Worker service token |
| Cloudflare Worker | `GITHUB_REPOSITORY` | Exact `owner/repository` trusted for runner OIDC |
| Cloudflare Worker | `GITHUB_WORKFLOW_REF` | Exact workflow ref, e.g. `owner/repository/.github/workflows/hardwire-poc.yml@refs/heads/main` |
| Cloudflare Worker | `OIDC_AUDIENCE` | Exact audience configured in Worker and GitHub Actions variable |
| Cloudflare Worker | `RETENTION_SECONDS` | Defaults to `259200` (72 hours); may be shortened only in a dedicated validation environment |
| GitHub repository variable | `DATA_WORKER_URL` | Deployed Worker HTTPS origin |
| GitHub repository variable | `HARDWIRE_OIDC_AUDIENCE` | Must equal the Worker `OIDC_AUDIENCE` |
| GitHub repository secrets | `OPENAI_API_KEY`, `WOKWI_CLI_TOKEN` | Separate credentials for the OpenCode and Wokwi containers |

The model feasibility probe used the exact model ID `gpt-6-luna`. The runner uses OpenCode's configured provider; model routing must be configured and rechecked in the runner image before live runs. The Worker keeps an owner-level aggregate usage ledger after run/project expiry and admits a new run only when measured PoC spend plus its approved `maxUsd` reservation stays at or below $10. Current cost is provider/OpenCode usage data, not an invoice; a model request already in flight can overshoot before its usage event arrives, so this is not a strict billing cap.

## Deployment order

Cloudflare D1/R2, the data Worker, and the founder UI/API Worker are deployed. The UI and health endpoint are live. `DATA_API_TOKEN` is already configured on both Workers. Founder login and Actions dispatch remain unavailable until their credentials are configured.

1. **Enable founder login.** From the repo root, run `npm run founder:password` in an interactive terminal. It asks for a 12–1024 character password twice without echoing it, derives the required scrypt hash, and pipes only that hash into Wrangler. Do not send the password or hash in chat. Migration `0002_founder_auth.sql` is already applied. Until this secret is set, protected API calls return typed 503 `missing_secret`.
2. **Restore GitHub Actions access.** Run `./node_modules/.bin/wrangler secret put GITHUB_PAT --config apps/api/wrangler.jsonc` with a valid fine-grained token scoped to `agenticbernie/hardwire`, with Actions read/write access. The previously available GitHub credential returned HTTP 403 (`Your account was suspended`), so no Actions run has been dispatched.
3. **Configure the GitHub repository.** The workflow on `main` is dispatch-only, and the deployed data Worker trusts this repo/workflow. Set repository variables `DATA_WORKER_URL=https://hardwire-data.bernie-web3.workers.dev` and `HARDWIRE_OIDC_AUDIENCE=hardwire-data`; set secrets `OPENAI_API_KEY` and `WOKWI_CLI_TOKEN` through GitHub's secret settings. The Wokwi token is not available in this environment. Do not add product source or evidence to Actions artifacts/cache uploads.
4. **Continue end-to-end verification.** Confirm founder login, authenticated data Worker access, task approval, GitHub dispatch, OIDC exchange and cancellation. Then run the baseline Wokwi scenario, validate actual Serial and TFT captures, inject behavior/display defects, and test repair/checkpoints/export/import. Three independent demo runs and a separate elapsed 72-hour cleanup observation remain required before declaring PoC acceptance.

The deployed data plane is D1 `hardwire` (APAC, ID `08adc5cc-150e-4365-a9d9-239d52cdcf00`), private R2 bucket `hardwire-private` (APAC), and Worker `hardwire-data` at `https://hardwire-data.bernie-web3.workers.dev` with the `*/15 * * * *` cleanup cron. Migrations `0001_hardwire.sql` and `0002_founder_auth.sql` are applied. The founder app Worker is `hardwire-app` at `https://hardwire-app.bernie-web3.workers.dev`. Remote smoke checks returned 200 for `/` and `/healthz`; `/api/usage` returned the expected 503 until founder login is configured. These checks do not prove authenticated data operations.

To reproduce the remote migration and deployment (Wrangler must be authenticated to the intended account):

```sh
./node_modules/.bin/wrangler deploy --config apps/data-worker/wrangler.jsonc
npm run deploy:cloudflare-app
```

D1/R2 contents remain behind Worker ownership, expiry and credential checks; do not enable public bucket access.

## Evidence and limits

- [Feasibility experiments](docs/hardwire/feasibility.md) record actual PlatformIO/model probes and missing live-service proof.
- [FR/AC traceability](docs/hardwire/traceability.md) reports each requirement against local and live evidence.
- [Interface contract](docs/hardwire/interfaces.md) defines API routes, run state, evidence identity and archive format.
- [Implementation plan and execution notes](docs/superpowers/plans/2026-10-17-hardwire-poc.md) record task owners and verification.
- Component security/configuration notes: [API](apps/api/README.md), [Worker](apps/data-worker/README.md), [runner](apps/runner/README.md).

Passing local tests, a baseline firmware build, and successful model probes do not establish authenticated Cloudflare data operations, Wokwi screenshots, GitHub Actions dispatch, visual-evaluator accuracy, real 72-hour deletion, or the three-run acceptance criterion. Current blockers are summarized in the [feasibility record](docs/hardwire/feasibility.md#open-prerequisites).
