# Hardwire repository context

## Status and source of truth

Hardwire is a new repository scaffold created from an empty workspace on 2026-10-17. There was no application code, local README, package manifest, repository-specific `AGENTS.md`, or usable Git metadata at start. The full product and technical source is the user's “HARDWIRE — PoC Product & Technical Specification v0.1” from 2026-10-17; do not reinterpret approved scope.

## Routing

- Product requirements and FR/AC ownership: `docs/hardwire/traceability.md`.
- Feasibility experiments and observed blockers: `docs/hardwire/feasibility.md`.
- Implementation task order and component contracts: `docs/superpowers/plans/2026-10-17-hardwire-poc.md`.
- Root scripts, runtime versions and environment names: `package.json` and `README.md`.

## Approved product shape

Founder-only PoC. React/Vite UI; Node 24/Fastify API hosted as a conventional Botkeep application; Cloudflare Worker for D1/R2 access and retention; one sequential GitHub Actions runner using OpenCode, PlatformIO, Wokwi, and evidence evaluation. One active product task, one initial coding attempt, up to three repair rounds, 30-minute workflow timeout, $10 total OpenAI PoC budget, 72-hour project retention, private artifacts and `.hardwire.zip` export/import.

Hardwire agent roles run sequentially. Do not add multiple concurrent product runs or treat Implementer/Evaluator/Repair as parallel agents.

## Proven environment facts

- Local runtime: Node.js 24.21.0 and npm 11.19.0.
- OpenCode CLI 1.18.34; direct `gpt-6-luna` and headless OpenCode inference have both returned successfully. Cost and token usage are recorded in the feasibility report. OpenCode's tested experimental output-token variable did not cap the overall multi-step session.
- Pinned Gunny Arcade snapshot: commit `f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc`; unchanged PlatformIO build succeeds for `esp32dev`.
- Wokwi CLI 0.28.1 local options and diagram lint work. Actual simulation cannot pass the local authentication gate because `WOKWI_CLI_TOKEN` is absent.
- Workspace is not a Git checkout. Do not claim branch/diff/commit or GitHub Actions integration proof unless a repository is provided/configured.
- Botkeep means `botkeep.cloud` for this plan. No public provisioning API was verified; use the supported dashboard/GitHub import and do not invent API calls.
- Cloudflare bindings and GitHub Actions REST interfaces are documented, but no deploy or dispatch has been made.

## Security and evidence rules

Never print or store secret values. Product source, OpenAI credentials, GitHub credentials, Cloudflare credentials, and Wokwi credentials have separate boundaries. OpenCode subprocesses must not inherit GitHub/Cloudflare runner credentials. Evidence and export manifests identify run, attempt, test case, source/tree, firmware, scenario, criteria version, tools and checksums. A successful build alone is not an acceptance pass. Missing artifacts and service credentials are `inconclusive` or a typed infrastructure blocker.

## Current structure

The workspace now contains `packages/contracts`, `apps/api`, `apps/data-worker`, `apps/runner`, `apps/web`, the D1 migration, and one GitHub Actions workflow. The implementation is published in `agenticbernie/hardwire` on `main` at commit `3f783b7`. The original local workspace still has no Git metadata. Local tests do not establish deployed cloud integrations; use `docs/hardwire/traceability.md` and `feasibility.md` for current evidence status.
