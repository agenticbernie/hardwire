import { z } from "zod";

export const executionStateSchema = z.enum([
  "queued",
  "preparing",
  "coding",
  "building",
  "simulating",
  "evaluating",
  "repairing",
  "needs_decision",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const acceptanceOutcomeSchema = z.enum(["passed", "failed", "inconclusive"]);
export const criterionOutcomeSchema = acceptanceOutcomeSchema;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const evidenceKindSchema = z.enum(["build_log", "serial_log", "screenshot", "diff", "report", "checkpoint"]);

export const taskLimitsSchema = z.object({
  timeoutSeconds: z.number().int().positive().max(1800),
  maxRepairRounds: z.number().int().min(0).max(3),
  maxUsd: z.number().positive().max(10),
}).strict();

export const criterionSchema = z.object({
  id: z.string().min(1).max(80),
  required: z.boolean(),
  text: z.string().min(1).max(2000),
  evidence: z.array(evidenceKindSchema).min(1),
}).strict();

export const approvalMaterialSchema = z.object({
  taskId: z.string().min(1),
  taskVersion: z.number().int().positive(),
  objective: z.string().min(1).max(10000),
  allowedPaths: z.array(z.string().min(1)).min(1),
  limits: taskLimitsSchema,
  criteria: z.array(criterionSchema).min(1),
}).strict().superRefine((value, context) => {
  for (const [index, path] of value.allowedPaths.entries()) {
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
      context.addIssue({ code: "custom", path: ["allowedPaths", index], message: "Paths must remain relative to the product workspace" });
    }
  }
});

export type ApprovalMaterial = z.infer<typeof approvalMaterialSchema>;

export const evidenceIdentitySchema = z.object({
  runId: z.string().min(1),
  attempt: z.number().int().positive(),
  testCaseId: z.string().min(1),
  sourceHash: hashSchema,
  firmwareHash: hashSchema,
  scenarioHash: hashSchema,
  criteriaHash: hashSchema,
}).strict();

export type EvidenceIdentity = z.infer<typeof evidenceIdentitySchema>;

export const runStartRequestSchema = z.object({
  version: z.number().int().positive(),
  approvalHash: hashSchema,
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export const runEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  type: z.enum(["state", "checkpoint", "usage", "artifact", "criterion", "issue", "heartbeat", "terminal"]),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export const criterionResultSchema = z.object({
  criterionId: z.string().min(1),
  outcome: criterionOutcomeSchema,
  explanation: z.string().min(1),
  evidenceIds: z.array(z.string()),
  sourceHash: hashSchema,
  firmwareHash: hashSchema,
  scenarioHash: hashSchema,
  criteriaHash: hashSchema,
}).strict();

const toolVersionsSchema = z.record(z.string().min(1), z.string().min(1));
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/, "Expected a SHA-1 or SHA-256 Git commit ID");

export const artifactUploadMetadataSchema = evidenceIdentitySchema.extend({
  kind: evidenceKindSchema,
  toolVersions: toolVersionsSchema,
  mediaType: z.string().min(1).max(160),
  byteSize: z.number().int().nonnegative(),
  sha256: hashSchema,
  capturedAt: z.string().datetime({ offset: true }),
}).strict();

export const artifactMetadataSchema = artifactUploadMetadataSchema.extend({
  artifactId: z.string().min(1),
  r2Key: z.string().min(1),
}).strict();

const archivePathSchema = z.string().min(1).max(1024).refine((path) => {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Archive paths must be normalized relative paths");

export const archiveFileSchema = z.object({
  path: archivePathSchema,
  byteSize: z.number().int().nonnegative(),
  sha256: hashSchema,
  mediaType: z.string().min(1).max(160),
}).strict();

const archiveTaskSchema = z.object({
  taskId: z.string().min(1),
  version: z.number().int().positive(),
  objective: z.string().min(1).max(10000),
  allowedPaths: z.array(archivePathSchema).min(1),
  limits: taskLimitsSchema,
  approvalHash: hashSchema,
  approvedAt: z.string().datetime({ offset: true }).nullable(),
  criteria: z.array(criterionSchema).min(1),
}).strict();

const archiveAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  sourceHash: hashSchema,
  firmwareHash: hashSchema.nullable(),
  scenarioHash: hashSchema.nullable(),
  executionState: executionStateSchema,
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const archiveUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  reportedCostUsd: z.number().nonnegative().nullable(),
  wokwiSeconds: z.number().nonnegative(),
  githubActionsSeconds: z.number().nonnegative(),
  artifactBytes: z.number().int().nonnegative(),
}).strict();

const archiveArtifactSchema = artifactUploadMetadataSchema.extend({ path: archivePathSchema }).strict();

const archiveRunSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.number().int().positive(),
  executionState: executionStateSchema,
  acceptanceOutcome: acceptanceOutcomeSchema.nullable(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  attempts: z.array(archiveAttemptSchema),
  testResults: z.array(criterionResultSchema),
  usage: archiveUsageSchema,
  artifacts: z.array(archiveArtifactSchema),
}).strict();

export const archiveManifestSchema = z.object({
  format: z.literal("hardwire-archive"),
  formatVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  project: z.object({ name: z.string().min(1).max(160), sourceCommit: gitCommitSchema.nullable() }).strict(),
  tasks: z.array(archiveTaskSchema),
  runs: z.array(archiveRunSchema),
  files: z.array(archiveFileSchema),
}).strict().superRefine((manifest, context) => {
  const filePaths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (file.path === "manifest.json") {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "The manifest cannot list itself" });
    }
    if (filePaths.has(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Archive file paths must be unique" });
    }
    filePaths.add(file.path);
  }

  manifest.runs.forEach((run, runIndex) => run.artifacts.forEach((artifact, artifactIndex) => {
    if (!filePaths.has(artifact.path)) {
      context.addIssue({ code: "custom", path: ["runs", runIndex, "artifacts", artifactIndex, "path"], message: "Artifact path must refer to a listed archive file" });
    }
    const file = manifest.files.find((entry) => entry.path === artifact.path);
    if (file && (file.sha256 !== artifact.sha256 || file.byteSize !== artifact.byteSize || file.mediaType !== artifact.mediaType)) {
      context.addIssue({ code: "custom", path: ["runs", runIndex, "artifacts", artifactIndex], message: "Artifact metadata must match its archive file entry" });
    }
  }));
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export async function hashApprovalMaterial(material: ApprovalMaterial): Promise<string> {
  const validated = approvalMaterialSchema.parse(material);
  const bytes = new TextEncoder().encode(canonicalJson(validated));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function evidenceIdentityMatches(actual: EvidenceIdentity, expected: EvidenceIdentity): boolean {
  const left = evidenceIdentitySchema.safeParse(actual);
  const right = evidenceIdentitySchema.safeParse(expected);
  if (!left.success || !right.success) return false;

  const identity = left.data;
  const target = right.data;
  return identity.runId === target.runId
    && identity.attempt === target.attempt
    && identity.testCaseId === target.testCaseId
    && identity.sourceHash === target.sourceHash
    && identity.firmwareHash === target.firmwareHash
    && identity.scenarioHash === target.scenarioHash
    && identity.criteriaHash === target.criteriaHash;
}
