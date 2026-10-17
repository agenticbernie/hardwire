import { randomUUID } from "node:crypto";
import { z } from "zod";
import { approvalMaterialSchema, criterionSchema, hashApprovalMaterial, hashSchema, runStartRequestSchema, taskLimitsSchema } from "../../../packages/contracts/src/index.ts";
import { ApiError } from "./errors.ts";
import type { GitHubActions, WorkflowStatus } from "./github.ts";
import type { JsonRecord, WorkerClient } from "./worker-client.ts";

export const PINNED_SOURCE_COMMIT = "f8db05d9dd573fb49941ffa510e3d4e9ba66cfbc";
const idSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const projectSchema = z.object({ name: z.string().min(1).max(120), source: z.object({ kind: z.literal("gunny-snapshot"), commit: z.literal(PINNED_SOURCE_COMMIT) }).strict() }).strict();
const taskSchema = z.object({ version: z.number().int().positive(), objective: z.string().min(1).max(10_000), allowedPaths: z.array(z.string().min(1)).min(1).max(100), limits: taskLimitsSchema, criteria: z.array(criterionSchema).min(1).max(100) }).strict();
const revisionSchema = taskSchema.omit({ version: true });
const approvalSchema = z.object({ version: z.number().int().positive(), approvalHash: hashSchema }).strict();
const resumeSchema = z.object({ idempotencyKey: z.string().min(8).max(200) }).strict();
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_request", "The request does not match the required format.");
  return parsed.data;
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "invalid_upstream_response", "The data service returned an invalid resource.");
  return value as JsonRecord;
}

function pick(value: unknown, fields: readonly string[]): JsonRecord {
  const source = record(value);
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

const projectFields = ["id", "projectId", "name", "source", "expiresAt", "createdAt"];
const taskFields = ["id", "taskId", "projectId", "taskVersion", "version", "objective", "allowedPaths", "limits", "criteria", "criteriaHash", "approvalHash", "approvedAt", "expiresAt"];
const runFields = ["id", "runId", "projectId", "taskId", "taskVersion", "executionState", "acceptanceOutcome", "approvalHash", "criteriaHash", "workflowRunId", "workflowUrl", "cancelRequested", "cancellationRequested", "attempt", "reason", "createdAt", "startedAt", "endedAt", "finishedAt", "expiresAt", "summary"];
const artifactFields = ["id", "artifactId", "runId", "attempt", "testCaseId", "kind", "sourceHash", "firmwareHash", "scenarioHash", "criteriaHash", "toolVersions", "sha256", "byteSize", "mediaType", "capturedAt", "expiresAt"];

export class FounderService {
  private readonly worker: WorkerClient;
  private readonly github: GitHubActions;
  constructor(worker: WorkerClient, github: GitHubActions) { this.worker = worker; this.github = github; }

  async projects(): Promise<JsonRecord> {
    const result = await this.worker.json("/v1/projects");
    return { projects: Array.isArray(result.projects) ? result.projects.map((value) => {
      const project = record(value);
      return { ...pick(project, projectFields), latestRun: project.latestRun && typeof project.latestRun === "object" ? pick(project.latestRun, runFields) : null };
    }) : [] };
  }

  async project(projectId: string): Promise<JsonRecord> {
    parse(idSchema, projectId);
    const result = await this.worker.json(`/v1/projects/${projectId}`);
    const project = record(result.project);
    const tasks = result.tasks ?? project.tasks;
    const runs = result.runs ?? project.runs;
    return {
      project: pick(project, projectFields),
      tasks: Array.isArray(tasks) ? tasks.map((task) => pick(task, taskFields)) : [],
      runs: Array.isArray(runs) ? runs.map((run) => pick(run, runFields)) : [],
      importHistory: result.importHistory ?? project.importedHistory ?? null,
    };
  }

  async createProject(body: unknown): Promise<JsonRecord> {
    const input = parse(projectSchema, body);
    const result = await this.worker.json("/v1/projects", "POST", input);
    return { project: pick(result.project, projectFields) };
  }

  async createTask(projectId: string, body: unknown): Promise<JsonRecord> {
    parse(idSchema, projectId);
    const input = parse(taskSchema, body);
    const taskId = randomUUID();
    return this.saveTask(taskId, projectId, input);
  }

  async reviseTask(taskId: string, body: unknown): Promise<JsonRecord> {
    parse(idSchema, taskId);
    const input = parse(revisionSchema, body);
    const result = await this.worker.json(`/v1/tasks/${taskId}`);
    const current = record(result.task);
    const projectId = parse(idSchema, current.projectId);
    const version = parse(z.number().int().positive(), current.taskVersion ?? current.version) + 1;
    return this.saveTask(taskId, projectId, { ...input, version });
  }

  private async saveTask(taskId: string, projectId: string, input: z.infer<typeof taskSchema>): Promise<JsonRecord> {
    const material = parse(approvalMaterialSchema, { taskId, taskVersion: input.version, objective: input.objective, allowedPaths: input.allowedPaths, limits: input.limits, criteria: input.criteria });
    const approvalHash = await hashApprovalMaterial(material);
    const result = await this.worker.json("/v1/tasks", "POST", { ...input, projectId, taskId });
    const task = record(result.task);
    if (task.approvalHash !== approvalHash) throw new ApiError(502, "invalid_upstream_response", "The saved task does not match its approval material.");
    return { task: pick(task, taskFields) };
  }

  async approve(taskId: string, body: unknown): Promise<JsonRecord> {
    parse(idSchema, taskId);
    const input = parse(approvalSchema, body);
    const result = await this.worker.json(`/v1/tasks/${taskId}/approve`, "POST", input);
    const task = record(result.task);
    if (task.approvalHash !== input.approvalHash || (task.taskVersion ?? task.version) !== input.version || !task.approvedAt) throw new ApiError(502, "invalid_upstream_response", "The approval response did not match the requested revision.");
    return { task: pick(task, taskFields) };
  }

  async start(taskId: string, body: unknown): Promise<JsonRecord> {
    parse(idSchema, taskId);
    const input = parse(runStartRequestSchema, body);
    this.github.requireConfigured();
    const taskResult = await this.worker.json(`/v1/tasks/${taskId}`);
    const task = record(taskResult.task);
    if ((task.taskVersion ?? task.version) !== input.version || task.approvalHash !== input.approvalHash || !task.approvedAt) throw new ApiError(409, "stale_approval", "Approve this exact task revision before starting a run.");
    const criteriaHash = parse(hashSchema, task.criteriaHash);
    // The Worker transaction inserts the durable dispatch claim before this call returns.
    // Never retry dispatch, even when its HTTP response or the workflow attach is lost.
    const result = await this.worker.json("/v1/runs", "POST", { taskId, taskVersion: input.version, approvalHash: input.approvalHash, criteriaHash, idempotencyKey: input.idempotencyKey });
    const run = result.run ? record(result.run) : { runId: result.runId, executionState: result.executionState };
    const runId = parse(idSchema, run.id ?? run.runId ?? result.runId);
    if (typeof result.created !== "boolean") throw new ApiError(502, "invalid_upstream_response", "The data service did not confirm the dispatch claim.");
    if (!result.created) return { run: pick(run, runFields), created: false, dispatch: { status: run.workflowRunId ? "attached" : "pending_reconciliation" } };
    let workflow;
    try { workflow = await this.github.dispatch(runId); } catch {
      return { run: pick(run, runFields), created: true, dispatch: { status: "pending_reconciliation", reason: "dispatch_unknown", message: "Dispatch outcome requires reconciliation; retrying start will return this run without dispatching again." } };
    }
    try {
      const attached = await this.worker.json(`/v1/runs/${runId}/workflow`, "POST", workflow);
      return { run: pick(attached.run, runFields), created: true, dispatch: { status: "attached", ...workflow } };
    } catch {
      // Keep the row/active lock: GitHub may have accepted the request. The same
      // idempotency key always maps to this run and never dispatches it again.
      return { run: pick(run, runFields), created: true, dispatch: { status: "pending_reconciliation", reason: "workflow_persistence_failed", ...workflow, message: "GitHub accepted the run; its workflow identity still needs to be saved. This run will not be dispatched again." } };
    }
  }

  async resume(runId: string, body: unknown): Promise<JsonRecord> {
    parse(idSchema, runId);
    const input = parse(resumeSchema, body);
    this.github.requireConfigured();
    // The Worker transaction only grants a new dispatch claim when the run is
    // interrupted and has a checksum-verified checkpoint. Replays return the
    // same claim with created=false, so they must never dispatch again.
    const result = await this.worker.json(`/v1/runs/${runId}/resume`, "POST", input);
    const run = result.run ? record(result.run) : { runId: result.runId, executionState: result.executionState };
    const resolvedRunId = parse(idSchema, run.id ?? run.runId ?? result.runId);
    if (typeof result.created !== "boolean") throw new ApiError(502, "invalid_upstream_response", "The data service did not confirm the resume claim.");
    if (!result.created) return { run: pick(run, runFields), created: false, dispatch: { status: run.workflowRunId ? "attached" : "pending_reconciliation" } };
    let workflow;
    try { workflow = await this.github.dispatch(resolvedRunId); } catch {
      return { run: pick(run, runFields), created: true, dispatch: { status: "pending_reconciliation", reason: "dispatch_unknown", message: "Dispatch outcome requires reconciliation; retrying resume will not dispatch again." } };
    }
    try {
      const attached = await this.worker.json(`/v1/runs/${resolvedRunId}/workflow`, "POST", workflow);
      return { run: pick(attached.run, runFields), created: true, dispatch: { status: "attached", ...workflow } };
    } catch {
      return { run: pick(run, runFields), created: true, dispatch: { status: "pending_reconciliation", reason: "workflow_persistence_failed", ...workflow, message: "GitHub accepted the resumed run; its workflow identity still needs to be saved. This run will not be dispatched again." } };
    }
  }

  async run(runId: string): Promise<JsonRecord> {
    parse(idSchema, runId);
    let result = await this.worker.json(`/v1/runs/${runId}`);
    let run = record(result.run);
    let workflow: WorkflowStatus | { status: string; reason: string } | null = null;
    if (run.workflowRunId) {
      try {
        workflow = await this.github.status(String(run.workflowRunId));
        if (workflow.status === "completed" && !terminal.has(String(run.executionState))) {
          await this.worker.json(`/v1/runs/${runId}/reconcile`, "POST", { workflowRunId: String(run.workflowRunId), status: workflow.status, conclusion: workflow.conclusion });
          result = await this.worker.json(`/v1/runs/${runId}`);
          run = record(result.run);
        }
      } catch { workflow = { status: "unavailable", reason: "service_unavailable" }; }
    }
    return {
      run: pick(run, runFields),
      usage: result.usage ?? null,
      criteria: result.criteria ?? [],
      attempts: result.attempts ?? [],
      artifacts: Array.isArray(result.artifacts) ? result.artifacts.map((artifact) => {
        const visible = pick(artifact, artifactFields);
        const id = String(visible.artifactId ?? visible.id ?? "");
        return { ...visible, downloadPath: `/api/artifacts/${encodeURIComponent(id)}` };
      }) : [],
      lastSequence: result.lastSequence ?? null,
      workflow,
      dispatch: { status: run.workflowRunId ? "attached" : "pending_reconciliation" },
      limits: { hardDollarCapVerified: false, lifetimeBudgetAdmissionEnforced: true, message: "New runs reserve their approved maxUsd against the $10 measured PoC total. Provider cost is reported after model events, so an in-flight call can overshoot the limit." },
    };
  }

  async cancel(runId: string): Promise<JsonRecord> {
    parse(idSchema, runId);
    const result = await this.worker.json(`/v1/runs/${runId}/cancel`, "POST", {});
    const run = record(result.run);
    if (terminal.has(String(run.executionState))) return { run: pick(run, runFields), cancellation: { status: "terminal" } };
    if (!run.workflowRunId) return { run: pick(run, runFields), cancellation: { status: "pending_reconciliation", message: "Cancellation is stored; the dispatch identity is not yet available." } };
    try {
      await this.github.cancel(String(run.workflowRunId));
      return { run: pick(run, runFields), cancellation: { status: "requested" } };
    } catch {
      return { run: pick(run, runFields), cancellation: { status: "pending_reconciliation", reason: "service_unavailable" } };
    }
  }

  async usage(): Promise<JsonRecord> {
    const result=await this.worker.json("/v1/usage");
    const totals=result.totals ?? result.usage ?? result;
    return { ...result, totals, runs:Array.isArray(result.runs)?result.runs:[], hardDollarCapVerified:false };
  }

  async exportProject(projectId: string): Promise<JsonRecord> {
    parse(idSchema, projectId);
    const result = await this.worker.json("/v1/exports", "POST", { projectId });
    const exported = pick(result.export, ["id", "projectId", "sha256", "byteSize", "expiresAt"]);
    parse(idSchema, exported.id);
    return { export: { ...exported, downloadPath: `/api/exports/${exported.id}` } };
  }

  async importProject(bytes: Buffer): Promise<JsonRecord> {
    if (bytes.length < 4 || bytes.length > 32 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) throw new ApiError(400, "invalid_request", "A nonempty .hardwire.zip archive is required.");
    // ZIP parsing, manifest validation, checksum validation, and safe object writes
    // are performed by the Worker archive service. Imported bytes never execute.
    const response = await this.worker.request("/v1/imports", "POST", bytes, "application/zip");
    let result: JsonRecord;
    try { result = record(await response.json()); } catch { throw new ApiError(502, "invalid_upstream_response", "The import service returned an invalid response."); }
    return { project: pick(result.project, projectFields) };
  }

  async download(kind: "artifacts" | "exports", id: string): Promise<Response> {
    parse(idSchema, id);
    return this.worker.request(`/v1/${kind}/${id}`);
  }
}
