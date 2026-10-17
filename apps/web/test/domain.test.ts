import test from "node:test";
import assert from "node:assert/strict";
import { criterionViews, formatBytes, isRunActive, mergeCriterionViews, outcomeLabel, safeWorkflowUrl, timeRemaining, verifiedAcceptanceOutcome } from "../src/domain.ts";

test("unknown criteria stay inconclusive and preserve evidence references", () => {
  const [criterion] = criterionViews([{ criterionId: "tft-state", text: "TFT đúng", evidenceIds: ["img-1"] }]);
  assert.equal(criterion.outcome, "inconclusive");
  assert.equal(criterion.explanation, "Chưa có kết luận và bằng chứng đủ để xác minh.");
  assert.deepEqual(criterion.evidenceIds, ["img-1"]);
});

test("run execution state and acceptance outcome remain separate", () => {
  assert.equal(isRunActive("simulating"), true);
  assert.equal(isRunActive("failed"), false);
  assert.equal(outcomeLabel("passed"), "Đạt");
  assert.equal(outcomeLabel("failed"), "Chưa đạt");
  assert.equal(outcomeLabel(null), "Chưa đủ bằng chứng");
});

test("missing required criterion evidence prevents an aggregate pass", () => {
  const expected = criterionViews([
    { id: "timer", required: true, text: "Timer transition", evidence: ["serial_log"] },
    { id: "display", required: true, text: "TFT state", evidence: ["screenshot"] },
  ]);
  const observed = criterionViews([{ criterionId: "timer", outcome: "passed", explanation: "Turn changed", evidenceIds: ["serial-1"] }]);
  const merged = mergeCriterionViews(expected, observed);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].outcome, "inconclusive");
  assert.equal(verifiedAcceptanceOutcome(merged, "passed"), "inconclusive");
});

test("a required failed criterion cannot be presented as a pass", () => {
  const result = criterionViews([{ criterionId: "timer", required: true, outcome: "failed", explanation: "No turn change" }]);
  assert.equal(verifiedAcceptanceOutcome(result, "passed"), "failed");
});

test("formatting handles missing values and expiry without extending it", () => {
  assert.equal(formatBytes(undefined), "—");
  assert.equal(timeRemaining(undefined), "Chưa xác định");
  assert.equal(timeRemaining("2026-10-17T00:00:00.000Z", Date.parse("2026-10-17T00:00:00.000Z")), "Đã hết hạn");
});

test("workflow links only allow the GitHub Actions origin", () => {
  assert.equal(safeWorkflowUrl("https://github.com/owner/repo/actions/runs/123"), "https://github.com/owner/repo/actions/runs/123");
  assert.equal(safeWorkflowUrl("https://evil.example/run"), null);
});
