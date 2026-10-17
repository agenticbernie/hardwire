import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeEnvironment, redact, assertAllowedChanges, fileMap, sha256, budgetStop, parseUsage, decodePng, evaluateCriteria } from "../src/safety.ts";
import { runProcess } from "../src/process.ts";
import { containerEnvironmentArguments } from "../src/sandbox.ts";

test("child environment excludes runner, Actions, Cloudflare and simulator credentials", () => {
  const env = safeEnvironment("agent", { OPENAI_API_KEY: "model-key", WOKWI_CLI_TOKEN: "wokwi-key", GITHUB_TOKEN: "github-key", DATA_API_TOKEN: "worker-key", PATH: "/malicious" });
  assert.equal(env.OPENAI_API_KEY, "model-key");
  assert.equal(env.WOKWI_CLI_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.DATA_API_TOKEN, undefined);
  assert.equal(safeEnvironment("build", { OPENAI_API_KEY: "model-key" }).OPENAI_API_KEY, undefined);
  assert.equal(safeEnvironment("simulation", { WOKWI_CLI_TOKEN: "wokwi-key", OPENAI_API_KEY: "model-key" }).OPENAI_API_KEY, undefined);
  assert.equal(safeEnvironment("simulation", { WOKWI_CLI_TOKEN: "wokwi-key" }).WOKWI_CLI_TOKEN, "wokwi-key");
});

test("container PATH and HOME survive host Docker configuration without credentials in process arguments", () => {
  const args = containerEnvironmentArguments(safeEnvironment("agent", { OPENAI_API_KEY: "private-provider-canary" }));
  assert.ok(args.includes("PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin"));
  assert.ok(args.includes("HOME=/tmp/home"));
  assert.ok(args.includes("OPENAI_API_KEY"));
  assert.ok(!args.join(" ").includes("private-provider-canary"));
});

test("diff guard rejects protected files, traversal and symlinks even with broad task allowlists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-guard-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/main.cpp"), "old");
    const baseline = await fileMap(dir);
    await writeFile(join(dir, "src/main.cpp"), "new");
    assert.deepEqual(assertAllowedChanges(baseline, await fileMap(dir), ["src/**"]), ["src/main.cpp"]);
    assert.throws(() => assertAllowedChanges(baseline, { ...baseline, "../escape.cpp": "bad" }, ["**"]));
    assert.throws(() => assertAllowedChanges(baseline, { ...baseline, "opencode.json": "bad" }, ["**"]));
    await symlink("/etc/passwd", join(dir, "src/escape.h"));
    await assert.rejects(fileMap(dir), /symlink/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("redaction removes exact credentials and common provider/bearer key formats", () => {
  const result = redact('token=private-canary Authorization: Bearer abc-def sk-proj-1234567890abcdefghijklmnop', ["private-canary"]);
  assert.ok(!result.includes("private-canary"));
  assert.ok(!result.includes("abc-def"));
  assert.ok(!result.includes("sk-proj-"));
});

test("usage parses actual step_finish shape and stop policy never relies on experimental output cap", () => {
  const usage = parseUsage({ type: "step_finish", part: { id: "part1", cost: 0.12, tokens: { input: 20, output: 1003, reasoning: 4, cache: { read: 12, write: 30 } } } });
  assert.deepEqual(usage, { stepId: "part1", inputTokens: 20, outputTokens: 1003, reasoningTokens: 4, cacheReadTokens: 12, cacheWriteTokens: 30, costUsd: 0.12 });
  assert.equal(budgetStop({ steps: 1, costUsd: 0.12, elapsedMs: 100, repairs: 0 }, { maxUsd: 0.1, maxRepairRounds: 3, timeoutSeconds: 1800 }), "budget_measured");
  assert.equal(budgetStop({ steps: 25, costUsd: 0, elapsedMs: 100, repairs: 0 }, { maxUsd: 1, maxRepairRounds: 3, timeoutSeconds: 1800 }), "step_limit");
});

test("process supervisor enforces wall-clock timeout and cancellation", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  const controller = new AbortController();
  controller.abort("cancelled");
  await assert.rejects(runProcess(process.execPath, ["-e", "0"], { cwd: tmpdir(), env: {}, timeoutMs: 1000, signal: controller.signal }), /cancel/i);
});

test("PNG evidence requires actual fully decodable data, not a signature or truncated file", () => {
  assert.throws(() => decodePng(Buffer.from("89504e470d0a1a0a", "hex")), /PNG/i);
  // A real 1x1 RGBA PNG; dimensions are checked separately against the TFT contract.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");
  // This fixture has an intentionally damaged IDAT checksum and must not pass.
  assert.throws(() => decodePng(png), /PNG/i);
});

test("missing evidence, mismatched identity or infrastructure timeout can never pass", () => {
  const h = sha256("identity");
  const identity = { runId: "run1", attempt: 1, testCaseId: "gunny-30s", sourceHash: h, firmwareHash: h, scenarioHash: h, criteriaHash: h };
  const criteria = [{ id: "turn", required: true, text: "Turn expires", evidence: ["serial_log" as const] }];
  const proposal = [{ criterionId: "turn", outcome: "passed" as const, explanation: "observed", evidenceIds: ["log1"] }];
  const wrong = { ...identity, attempt: 2, artifactId: "log1", kind: "serial_log" as const, valid: true, sha256: h, byteSize: 10, mediaType: "text/plain", capturedAt: new Date().toISOString(), toolVersions: {} };
  assert.equal(evaluateCriteria(criteria, proposal, [], identity, undefined)[0]!.outcome, "inconclusive");
  assert.equal(evaluateCriteria(criteria, proposal, [wrong], identity, undefined)[0]!.outcome, "inconclusive");
  assert.equal(evaluateCriteria(criteria, proposal, [{ ...wrong, attempt: 1 }], identity, "timeout")[0]!.outcome, "inconclusive");
});
