import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceOutcomeSchema,
  archiveManifestSchema,
  artifactUploadMetadataSchema,
  evidenceIdentityMatches,
  executionStateSchema,
  hashApprovalMaterial,
  type ApprovalMaterial,
  type EvidenceIdentity,
} from "../src/index.ts";

const approval: ApprovalMaterial = {
  taskId: "task-1",
  taskVersion: 1,
  objective: "Set each turn to 30 seconds",
  allowedPaths: ["src/game.cpp"],
  limits: { timeoutSeconds: 1800, maxRepairRounds: 3, maxUsd: 1 },
  criteria: [{ id: "AC-06", required: true, text: "Turn changes after 30 seconds", evidence: ["serial_log"] }],
};

const evidence: EvidenceIdentity = {
  runId: "run-1",
  attempt: 1,
  testCaseId: "turn-timeout",
  sourceHash: "a".repeat(64),
  firmwareHash: "b".repeat(64),
  scenarioHash: "c".repeat(64),
  criteriaHash: "d".repeat(64),
};

test("execution state and acceptance outcome are separate dimensions", () => {
  assert.equal(executionStateSchema.parse("completed"), "completed");
  assert.equal(acceptanceOutcomeSchema.parse("inconclusive"), "inconclusive");
});

test("approval hash is deterministic and changes when an approved criterion changes", async () => {
  const first = await hashApprovalMaterial(approval);
  const second = await hashApprovalMaterial({ ...approval, criteria: [...approval.criteria] });
  const changed = await hashApprovalMaterial({
    ...approval,
    criteria: [{ ...approval.criteria[0]!, text: "Turn changes after 30 seconds and displays the next player" }],
  });

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, changed);
});

test("evidence can only support the exact run, attempt, source, firmware, scenario and criteria", () => {
  assert.equal(evidenceIdentityMatches(evidence, evidence), true);
  assert.equal(evidenceIdentityMatches(evidence, { ...evidence, firmwareHash: "e".repeat(64) }), false);
  assert.equal(evidenceIdentityMatches(evidence, { ...evidence, attempt: 2 }), false);
});

test("artifact upload metadata binds the bytes to tool versions and the approved evidence identity", () => {
  const metadata = artifactUploadMetadataSchema.parse({
    ...evidence,
    kind: "serial_log",
    toolVersions: { platformio: "6.2.0", wokwi: "0.28.1" },
    byteSize: 12,
    sha256: "e".repeat(64),
    mediaType: "text/plain",
    capturedAt: "2026-10-17T10:00:00Z",
  });

  assert.equal(metadata.toolVersions.wokwi, "0.28.1");
  assert.equal(artifactUploadMetadataSchema.safeParse({ ...metadata, byteSize: -1 }).success, false);
});

test("archive manifest v1 rejects unsafe paths, duplicate paths, and incomplete artifact references", () => {
  const manifest = {
    format: "hardwire-archive",
    formatVersion: 1,
    createdAt: "2026-10-17T10:00:00Z",
    project: { name: "Gunny Arcade", sourceCommit: null },
    tasks: [],
    runs: [],
    files: [{ path: "source/src/main.cpp", byteSize: 1, sha256: "a".repeat(64), mediaType: "text/plain" }],
  };

  assert.equal(archiveManifestSchema.safeParse(manifest).success, true);
  assert.equal(archiveManifestSchema.safeParse({ ...manifest, files: [{ ...manifest.files[0]!, path: "../secret" }] }).success, false);
  assert.equal(archiveManifestSchema.safeParse({ ...manifest, files: [...manifest.files, manifest.files[0]] }).success, false);
});
