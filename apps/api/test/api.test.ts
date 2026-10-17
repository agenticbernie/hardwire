import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashApprovalMaterial } from "../../../packages/contracts/src/index.ts";
import { createApp } from "../src/app.ts";
import type { WorkerBindings } from "../src/app.ts";
import { passwordHash, SESSION_COOKIE } from "../src/auth.ts";
import { readConfig } from "../src/config.ts";
import type { ApiConfig } from "../src/config.ts";
import type { Fetcher, JsonRecord } from "../src/worker-client.ts";

const origin = "https://hardwire.example";
const digest = await passwordHash("founder-password-for-test", "0123456789abcdef0123456789abcdef");
const config: ApiConfig = {
  publicOrigin: origin, founderId: "founder", founderPasswordHash: digest,
  workerUrl: "https://data.example", dataApiToken: "test-data-token-which-is-not-a-secret",
  githubToken: "test-github-token", githubOwner: "owner", githubRepo: "repo",
  githubWorkflow: "hardwire-poc.yml", githubRef: "main", host: "127.0.0.1", port: 3000,
};
const taskInput = {
  version: 1, objective: "Set the turn timer to 30 seconds", allowedPaths: ["src/main.cpp"],
  limits: { timeoutSeconds: 120, maxRepairRounds: 3, maxUsd: 1 },
  criteria: [{ id: "timer", text: "Turn expires after 30 seconds", required: true, evidence: ["serial_log"] as const }],
};
const taskId = "task-1";
const taskHash = await hashApprovalMaterial({ taskId, taskVersion: 1, objective: taskInput.objective, allowedPaths: taskInput.allowedPaths, limits: taskInput.limits, criteria: taskInput.criteria.map((criterion) => ({ ...criterion, evidence: [...criterion.evidence] })) });

type InjectInput = { url: string; method?: string; headers?: Record<string, string>; payload?: unknown };
type InjectResponse = { statusCode: number; headers: Record<string, string>; body: string; json<T = any>(): T };
type TestApp = ReturnType<typeof createApp> & { inject(input: InjectInput): Promise<InjectResponse>; close(): Promise<void> };

function testApp(app: ReturnType<typeof createApp>): TestApp {
  return Object.assign(app, {
    async inject({ url, method = "GET", headers: sourceHeaders = {}, payload }: InjectInput): Promise<InjectResponse> {
      const headers = new Headers(sourceHeaders);
      let body: BodyInit | undefined;
      if (payload !== undefined) {
        if (typeof payload === "string") body = payload;
        else if (payload instanceof Uint8Array) body = new Uint8Array(payload) as BodyInit;
        else {
          body = JSON.stringify(payload);
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
        }
      }
      const request = new Request(new URL(url, origin), { method, headers, body });
      const response = await app.fetch(request, {} as WorkerBindings);
      const responseBody = await response.text();
      return {
        statusCode: response.status,
        headers: (() => { const result: Record<string, string> = {}; response.headers.forEach((value, key) => { result[key] = value; }); return result; })(),
        body: responseBody,
        json<T = JsonRecord>(): T { return JSON.parse(responseBody) as T; },
      };
    },
    async close(): Promise<void> {},
  });
}

function json(body: unknown, status = 200): Response { return Response.json(body, { status }); }

function boundary(options: { dispatch?: "ok" | "missing" | "timeout" | "failed"; attachFails?: boolean; workflowConclusion?: string; budgetBlocked?: boolean } = {}) {
  let task: JsonRecord = { ...taskInput, id: taskId, taskId, taskVersion: 1, projectId: "project-1", criteriaHash: "b".repeat(64), approvalHash: taskHash, approvedAt: "2026-10-17T00:00:00.000Z" };
  let run: JsonRecord | undefined;
  let idempotencyKey = "";
  let resumeIdempotencyKey = "";
  let resumeClaimed = false;
  const requests: { url: string; init: RequestInit; body: JsonRecord | undefined }[] = [];
  let dispatchCount = 0;
  let cancellationCount = 0;
  const fetcher: Fetcher = async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) as JsonRecord : undefined;
    requests.push({ url, init, body });
    if (url.startsWith(config.workerUrl)) {
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${config.dataApiToken}`);
      assert.equal(new Headers(init.headers).get("x-founder-id"), "founder");
      if (path === `/v1/tasks/${taskId}`) return json({ task });
      if (path === "/v1/tasks") {
        const material = { taskId: String(body!.taskId), taskVersion: Number(body!.version), objective: String(body!.objective), allowedPaths: body!.allowedPaths as string[], limits: body!.limits as typeof taskInput.limits, criteria: body!.criteria as never };
        task = { ...body, id: body!.taskId, taskVersion: body!.version, approvalHash: await hashApprovalMaterial(material), criteriaHash: "c".repeat(64), approvedAt: null };
        return json({ task }, 201);
      }
      if (path === `/v1/tasks/${taskId}/approve`) {
        if (body?.approvalHash !== task.approvalHash || body?.version !== task.taskVersion) return json({ error: { code: "stale_approval" } }, 409);
        task.approvedAt = "2026-10-17T01:00:00.000Z";
        return json({ task });
      }
      if (path === "/v1/runs") {
        if (options.budgetBlocked) return json({ code: "poc_budget_limit" }, 409);
        if (run && body?.idempotencyKey !== idempotencyKey) return json({ error: { code: "run_conflict" } }, 409);
        const created = !run;
        if (!run) {
          idempotencyKey = String(body?.idempotencyKey);
          run = { id: "run-1", runId: "run-1", executionState: "queued", acceptanceOutcome: null, taskId, taskVersion: body?.taskVersion, approvalHash: body?.approvalHash, criteriaHash: body?.criteriaHash };
        }
        return json({ run, runId: "run-1", created });
      }
      if (path === "/v1/runs/run-1/resume" && init.method === "POST") {
        if (resumeClaimed && body?.idempotencyKey !== resumeIdempotencyKey) return json({ error: { code: "run_conflict" } }, 409);
        if (!resumeClaimed && (!run || run.executionState !== "interrupted")) return json({ error: { code: "run_conflict" } }, 409);
        const created = !resumeClaimed;
        if (created) {
          resumeClaimed = true;
          resumeIdempotencyKey = String(body?.idempotencyKey);
          run = { ...run, executionState: "queued", workflowRunId: undefined, workflowUrl: undefined };
        }
        return json({ run, created });
      }
      if (path.endsWith("/workflow")) {
        if (options.attachFails) throw new Error("upstream failure must never leak test-github-token");
        Object.assign(run!, body);
        return json({ run });
      }
      if (path === "/v1/runs/run-1" && init.method === "GET") return json({ run, usage: { openaiUsd: 0.01 }, criteria: [{ criterionId: "timer", outcome: "inconclusive" }], artifacts: [{ artifactId: "artifact-1", mediaType: "image/png", r2Key: "private/key", sha256: "f".repeat(64) }] });
      if (path.endsWith("/cancel")) { run!.cancelRequested = true; return json({ run }); }
      if (path.endsWith("/reconcile")) { run!.executionState = body?.conclusion === "cancelled" ? "cancelled" : "interrupted"; run!.acceptanceOutcome = "inconclusive"; return json({ run }); }
      if (path === "/v1/usage") return json({ usage: { inputTokens: 5, outputTokens: 2, reportedCostUsd: 0.01, providerUsageMeasured: true, pocBudgetRemainingUsd: 9.99, runCount: 1 }, totals: { inputTokens: 5, outputTokens: 2, reportedCostUsd: 0.01, providerUsageMeasured: true }, runs: [{ runId: "run-1", executionState: "completed", usage: { reportedCostUsd: 0.01 } }], budget: { capUsd: 10, admissionEnforced: true }, source: "measured" });
      if (path === "/v1/projects" && init.method === "GET") return json({ projects: [{ id: "project-1", name: "Gunny", source: { kind: "gunny-snapshot", commit: "f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc" }, ownerId: "founder" }] });
      if (path === "/v1/projects/project-1") return json({ project: { id: "project-1", name: "Gunny", tasks: [task], runs: run ? [run] : [], importedHistory: { formatVersion: 1, tasks: [] } } });
      if (path === "/v1/artifacts/expired") return json({}, 410);
      if (path === "/v1/artifacts/artifact-1") return new Response("safe-download", { headers: { "content-type": "text/html" } });
      if (path === "/v1/exports" && init.method === "POST") return json({ export: { id: "export-1", projectId: body?.projectId, downloadPath: "/v1/exports/export-1", sha256: "a".repeat(64), byteSize: 20 } });
      if (path === "/v1/imports") return json({ error: "unsafe archive" }, 422);
    }
    if (url.startsWith("https://api.github.com")) {
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("x-github-api-version"), "2026-03-10");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${config.githubToken}`);
      assert.notEqual(new Headers(init.headers).get("authorization"), `Bearer ${config.dataApiToken}`);
      if (path.endsWith("/dispatches")) {
        dispatchCount++;
        assert.deepEqual(body, { ref: "main", inputs: { run_id: "run-1" } });
        if (options.dispatch === "timeout") throw new Error("network lost");
        if (options.dispatch === "missing") return new Response(null, { status: 204 });
        if (options.dispatch === "failed") return json({ message: "private failure" }, 500);
        return json({ workflow_run_id: 42, html_url: "https://untrusted.example/ignored" });
      }
      if (path.endsWith("/cancel")) { cancellationCount++; return new Response(null, { status: 202 }); }
      if (path.endsWith("/runs/42")) return json({ id: 42, status: "completed", conclusion: options.workflowConclusion ?? "cancelled", run_started_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:01:00Z" });
    }
    throw new Error(`Unexpected boundary request ${init.method} ${path}`);
  };
  return { fetcher, requests, task: () => task, run: () => run, dispatchCount: () => dispatchCount, cancellationCount: () => cancellationCount };
}

async function authenticated(fetcher: Fetcher, now?: () => number) {
  const app = testApp(createApp(config, { fetcher, now }));
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "founder-password-for-test" } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
  const headers = { origin, cookie, "x-csrf-token": csrfToken };
  return { app, headers, cookie, csrfToken, login };
}

test("founder auth uses secure cookies, origin and CSRF; logout revokes the old token", async (t) => {
  const mock = boundary();
  const { app, headers, login, cookie } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  assert.match(String(login.headers["set-cookie"]), /HttpOnly; Secure; SameSite=Strict/);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.equal((await app.inject({ url: "/api/usage" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/task-1/approve", headers: { ...headers, origin: "https://evil.example" }, payload: { version: 1, approvalHash: taskHash } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/task-1/approve", headers: { origin, cookie }, payload: { version: 1, approvalHash: taskHash } })).statusCode, 403);
  const session = await app.inject({ url: "/api/auth/session", headers: { cookie } });
  assert.equal(session.json().csrfToken, headers["x-csrf-token"]);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, 204);
  assert.equal((await app.inject({ url: "/api/usage", headers: { cookie } })).statusCode, 401);
});

test("same-origin static UI serves the SPA and assets but keeps API 404s typed", async (t) => {
  const webRoot = await mkdtemp(join(tmpdir(), "hardwire-web-test-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Hardwire test shell</title>");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log('test');");
  const app = testApp(createApp(config, { fetcher: boundary().fetcher, webRoot }));
  t.after(async () => { await app.close(); await rm(webRoot, { recursive: true, force: true }); });

  const root = await app.inject({ method: "GET", url: "/" });
  assert.equal(root.statusCode, 200);
  assert.match(root.headers["content-type"] ?? "", /text\/html/);
  assert.equal(root.headers["x-content-type-options"], "nosniff");
  assert.match(root.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
  assert.match(root.body, /Hardwire test shell/);
  const route = await app.inject({ method: "GET", url: "/projects/project-1" });
  assert.equal(route.statusCode, 200);
  assert.match(route.body, /Hardwire test shell/);
  const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers["content-type"] ?? "", /text\/javascript/);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "founder-password-for-test" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  assert.equal((await app.inject({ method: "GET", url: "/api/does-not-exist", headers: { cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode, 404);
});

test("expired sessions deny requests and login attempts are bounded", async (t) => {
  let now = 1_000;
  const { app, headers } = await authenticated(boundary().fetcher, () => now);
  t.after(() => app.close());
  now += 8 * 60 * 60 * 1000;
  assert.equal((await app.inject({ url: "/api/usage", headers })).statusCode, 401);
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "wrong" } })).statusCode, 401);
  const limited = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: "wrong" } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "rate_limited");
});

test("approval pins version/hash; a new immutable revision becomes unapproved", async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  const stale = await app.inject({ method: "POST", url: "/api/tasks/task-1/approve", headers, payload: { version: 2, approvalHash: taskHash } });
  assert.equal(stale.statusCode, 409);
  const { version: _version, ...revision } = taskInput;
  const revised = await app.inject({ method: "POST", url: "/api/tasks/task-1/revisions", headers, payload: { ...revision, objective: "A changed requirement" } });
  assert.equal(revised.statusCode, 201);
  assert.equal(revised.json().task.taskVersion, 2);
  assert.equal(revised.json().task.taskId, "task-1");
  assert.equal(revised.json().task.approvedAt, null);
  assert.notEqual(revised.json().task.approvalHash, taskHash);
  const start = await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "revision-key" } });
  assert.equal(start.statusCode, 409);
  assert.equal(mock.dispatchCount(), 0);
});

test("concurrent retries create one run and exactly one dispatch; different key conflicts", async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  const start = (key = "same-key-1") => app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: key } });
  const responses = await Promise.all([start(), start(), start()]);
  assert.deepEqual(responses.map((response) => response.statusCode), [202, 202, 202]);
  assert.equal(responses.filter((response) => response.json().created).length, 1);
  assert.equal(mock.dispatchCount(), 1);
  assert.equal(mock.run()?.workflowRunId, "42");
  assert.equal(mock.run()?.workflowUrl, "https://github.com/owner/repo/actions/runs/42");
  assert.equal((await start("different-key")).statusCode, 409);
  assert.equal(mock.dispatchCount(), 1);
  const internal = mock.requests.find((request) => request.url.endsWith("/v1/runs"))!;
  assert.equal(internal.body?.taskVersion, 1);
  assert.equal(internal.body?.criteriaHash, "b".repeat(64));
  assert.equal(internal.body?.founderId, undefined);
});

for (const outcome of ["missing", "timeout", "failed"] as const) test(`dispatch ${outcome} response never triggers a second dispatch`, async (t) => {
  const mock = boundary({ dispatch: outcome });
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "same-key-1" } });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().dispatch.status, "pending_reconciliation");
    assert.doesNotMatch(response.body, /test-github-token|test-data-token|private failure/);
  }
  assert.equal(mock.dispatchCount(), 1);
});

test("workflow persistence failure returns known identity and keeps the dispatch claim", async (t) => {
  const mock = boundary({ attachFails: true });
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "same-key-1" } });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().dispatch.reason, "workflow_persistence_failed");
  assert.equal(response.json().dispatch.workflowRunId, "42");
  assert.equal(mock.dispatchCount(), 1);
});

test("resume dispatches an interrupted checkpoint run once and replays never dispatch again", async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "same-key-1" } });
  mock.run()!.executionState = "interrupted";
  const resume = () => app.inject({ method: "POST", url: "/api/runs/run-1/resume", headers, payload: { idempotencyKey: "resume-key-1" } });
  const first = await resume();
  assert.equal(first.statusCode, 202, first.body);
  assert.equal(first.json().created, true);
  assert.equal(first.json().dispatch.status, "attached");
  assert.equal(mock.dispatchCount(), 2);
  assert.equal(mock.run()?.workflowRunId, "42");
  const replay = await resume();
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().created, false);
  assert.equal(mock.dispatchCount(), 2);
});

test("ambiguous resume dispatch stays pending and cannot be retried into a duplicate workflow", async (t) => {
  const mock = boundary({ dispatch: "timeout" });
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "same-key-1" } });
  mock.run()!.executionState = "interrupted";
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({ method: "POST", url: "/api/runs/run-1/resume", headers, payload: { idempotencyKey: "resume-key-1" } });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().dispatch.status, "pending_reconciliation");
    assert.doesNotMatch(response.body, /test-github-token|test-data-token/);
  }
  assert.equal(mock.dispatchCount(), 2);
});

test("cancel is durable before Actions request; polling reconciles cancellation without acceptance pass", async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "same-key-1" } });
  const cancel = await app.inject({ method: "POST", url: "/api/runs/run-1/cancel", headers });
  assert.equal(cancel.statusCode, 202);
  assert.equal(mock.run()?.cancelRequested, true);
  assert.equal(mock.cancellationCount(), 1);
  const workerCancel = mock.requests.findIndex((request) => request.url === "https://data.example/v1/runs/run-1/cancel");
  const githubCancel = mock.requests.findIndex((request) => request.url.includes("api.github.com") && request.url.endsWith("/cancel"));
  assert.ok(workerCancel < githubCancel);
  const status = await app.inject({ url: "/api/runs/run-1", headers });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().run.executionState, "cancelled");
  assert.equal(status.json().run.acceptanceOutcome, "inconclusive");
  assert.equal(status.json().usage.openaiUsd, 0.01);
  assert.equal(status.json().limits.hardDollarCapVerified, false);
  assert.equal(status.json().artifacts[0].downloadPath, "/api/artifacts/artifact-1");
  assert.doesNotMatch(status.body, /private\/key/);
});

test("GitHub success alone remains inconclusive when runner has no acceptance evidence", async (t) => {
  const mock = boundary({ workflowConclusion: "success" });
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "same-key-1" } });
  const status = await app.inject({ url: "/api/runs/run-1", headers });
  assert.equal(status.json().run.acceptanceOutcome, "inconclusive");
  assert.equal(status.json().run.executionState, "interrupted");
});

test("usage API exposes normalized lifetime totals and retained per-run detail", async (t) => {
  const { app, headers } = await authenticated(boundary().fetcher);
  t.after(() => app.close());
  const response = await app.inject({ url: "/api/usage", headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().totals.inputTokens, 5);
  assert.equal(response.json().runs[0].runId, "run-1");
  assert.equal(response.json().budget.admissionEnforced, true);
  assert.equal(response.json().hardDollarCapVerified, false);
});

test("cumulative PoC budget rejection is explicit to the founder", async (t) => {
  const { app, headers } = await authenticated(boundary({ budgetBlocked: true }).fetcher);
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/runs", headers, payload: { version: 1, approvalHash: taskHash, idempotencyKey: "budget-session-key" } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "poc_budget_limit");
  assert.match(response.json().error.message, /remaining \$10 PoC budget/);
});

test("downloads enforce expiry upstream and force attachment for active content", async (t) => {
  const { app, headers } = await authenticated(boundary().fetcher);
  t.after(() => app.close());
  const expired = await app.inject({ url: "/api/artifacts/expired", headers });
  assert.equal(expired.statusCode, 410);
  const file = await app.inject({ url: "/api/artifacts/artifact-1", headers });
  assert.equal(file.statusCode, 200);
  assert.match(String(file.headers["content-disposition"]), /^attachment;/);
  assert.equal(file.headers["content-type"], "application/octet-stream");
  assert.equal(file.body, "safe-download");
});

test("export download path stays behind founder auth", async (t) => {
  const { app, headers } = await authenticated(boundary().fetcher);
  t.after(() => app.close());
  const exported = await app.inject({ method: "POST", url: "/api/projects/project-1/export", headers });
  assert.equal(exported.statusCode, 201);
  assert.equal(exported.json().export.downloadPath, "/api/exports/export-1");
  assert.equal((await app.inject({ url: "/api/exports/export-1" })).statusCode, 401);
});

for (const length of [0, 1, 2, 3]) test(`short malformed archive (${length} bytes) is rejected before Worker upload`, async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  const marker = "hardwire-test-boundary";
  const body = Buffer.concat([Buffer.from(`--${marker}\r\nContent-Disposition: form-data; name="file"; filename="test.hardwire.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.alloc(length), Buffer.from(`\r\n--${marker}--\r\n`)]);
  const response = await app.inject({ method: "POST", url: "/api/projects/import", headers: { ...headers, "content-type": `multipart/form-data; boundary=${marker}` }, payload: body });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
  assert.equal(mock.requests.filter((request) => request.url.endsWith("/v1/imports")).length, 0);
});

test("archive validator rejection propagates without executing or exposing upstream details", async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  const marker = "hardwire-test-boundary";
  const body = Buffer.concat([Buffer.from(`--${marker}\r\nContent-Disposition: form-data; name="file"; filename="test.hardwire.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`\r\n--${marker}--\r\n`)]);
  const response = await app.inject({ method: "POST", url: "/api/projects/import", headers: { ...headers, "content-type": `multipart/form-data; boundary=${marker}` }, payload: body });
  assert.equal(response.statusCode, 422);
  assert.doesNotMatch(response.body, /unsafe archive/);
});

test("configuration rejects insecure nonlocal endpoints and missing server credentials", () => {
  assert.throws(() => readConfig({ PUBLIC_ORIGIN: "http://evil.example", DATA_WORKER_URL: "https://data.example", DATA_API_TOKEN: "a".repeat(32), FOUNDER_PASSWORD_HASH: digest }), /HTTPS origin/);
  assert.throws(() => readConfig({}), /DATA_API_TOKEN/);
});

test("project history is read-only and founder scoped", async (t) => {
  const { app, headers } = await authenticated(boundary().fetcher);
  t.after(() => app.close());
  const projects = await app.inject({ url: "/api/projects", headers });
  assert.equal(projects.statusCode, 200);
  assert.equal(projects.json().projects[0].id, "project-1");
  assert.equal(projects.json().projects[0].ownerId, undefined);
  const detail = await app.inject({ url: "/api/projects/project-1", headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().tasks[0].approvalHash, taskHash);
  assert.deepEqual(detail.json().importHistory, { formatVersion: 1, tasks: [] });
});

test("extra multipart files reject before importing the first file", async (t) => {
  const mock = boundary();
  const { app, headers } = await authenticated(mock.fetcher);
  t.after(() => app.close());
  const marker = "hardwire-test-boundary";
  const part = Buffer.concat([Buffer.from(`--${marker}\r\nContent-Disposition: form-data; name="file"; filename="test.hardwire.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\r\n")]);
  const response = await app.inject({ method: "POST", url: "/api/projects/import", headers: { ...headers, "content-type": `multipart/form-data; boundary=${marker}` }, payload: Buffer.concat([part, part, Buffer.from(`--${marker}--\r\n`)]) });
  assert.equal(response.statusCode, 413);
  assert.equal(mock.requests.filter((request) => request.url.endsWith("/v1/imports")).length, 0);
});
