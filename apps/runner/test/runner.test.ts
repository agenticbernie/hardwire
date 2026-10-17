import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { runAttempts, serialMarkersPresent, SERIAL_MARKERS, checkpointStage } from "../src/runner.ts";
import { crc32, decodePng } from "../src/safety.ts";
import { stagePrerequisites } from "../src/preflight.ts";

test("missing Wokwi token is an explicit infrastructure blocker and never simulated success", () => {
  const result = stagePrerequisites({ OPENAI_API_KEY: "not-a-real-key" });
  assert.equal(result.ready, false);
  assert.equal(result.blocker, "missing_secret");
  assert.deepEqual(result.missing, ["WOKWI_CLI_TOKEN"]);
  assert.equal(result.simulationStatus, "blocked_missing_secret");
});

test("persistent product failure executes initial attempt plus at most three repairs", async () => {
  const attempts: number[] = [];
  const result = await runAttempts(3, 1, async (attempt) => { attempts.push(attempt); return { outcome: "failed", repairable: true, summary: "Compiler error with build log" }; }, () => undefined);
  assert.deepEqual(attempts, [1, 2, 3, 4]);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /repair limit/);
});

test("infrastructure blockers stop without repair and cancellation prevents the next attempt", async () => {
  let attempts = 0;
  const result = await runAttempts(3, 1, async () => { attempts++; return { outcome: "inconclusive", repairable: false, blocker: "missing_secret", summary: "WOKWI_CLI_TOKEN absent" }; }, () => undefined);
  assert.equal(attempts, 1);
  assert.equal(result.blocker, "missing_secret");
  await runAttempts(3, 1, async () => { attempts++; throw new Error("must not start"); }, () => "cancelled");
  assert.equal(attempts, 1);
});

test("resumption consumes only remaining repair rounds", async () => {
  const attempts: number[] = [];
  await runAttempts(3, 3, async (attempt) => { attempts.push(attempt); return { outcome: "failed", repairable: true, summary: "observed defect" }; }, () => undefined);
  assert.deepEqual(attempts, [3, 4]);
});

test("successful builds and every scenario/evaluation durably checkpoint before proceeding", async () => {
  const saved: string[] = [];
  await checkpointStage("build", false, async () => { saved.push("failed-build"); });
  await checkpointStage("build", true, async () => { saved.push("build"); });
  await checkpointStage("scenario", false, async () => { saved.push("scenario"); });
  await checkpointStage("evaluation", false, async () => { saved.push("evaluation"); });
  assert.deepEqual(saved, ["build", "scenario", "evaluation"]);
  await assert.rejects(checkpointStage("scenario", true, async () => { throw new Error("R2 unavailable"); }), /R2 unavailable/);
});

test("Serial proof rejects absent turn transition, wrong duration, and reordered input observations", () => {
  assert.equal(serialMarkersPresent(SERIAL_MARKERS.join("\n")), true);
  assert.equal(serialMarkersPresent(SERIAL_MARKERS.slice(0, -1).join("\n")), false);
  assert.equal(serialMarkersPresent(SERIAL_MARKERS.join("\n").replace("TURN P2 30s", "TURN P2 75s")), false);
  assert.equal(serialMarkersPresent([...SERIAL_MARKERS].reverse().join("\n")), false);
});

test("PNG parser decodes actual pixels and rejects tampered compressed data", () => {
  const chunk = (name: string, data: Buffer): Buffer => { const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual(decodePng(png), { width: 2, height: 1, distinctColors: 2 });
  const broken = Buffer.from(png); broken[45] = broken[45]! ^ 1;
  assert.throws(() => decodePng(broken), /PNG/i);
});
