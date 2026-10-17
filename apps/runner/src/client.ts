import { randomUUID } from "node:crypto";
import { z } from "zod";
import { approvalMaterialSchema, hashApprovalMaterial, hashSchema, runEventSchema, executionStateSchema } from "../../../packages/contracts/src/index.ts";
import { boundedBytes } from "./source.ts";
import { sha256 } from "./safety.ts";

export const runControlSchema = z.object({
  runId: z.string().min(1), projectId: z.string().min(1), taskId: z.string().min(1),
  approvalMaterial: approvalMaterialSchema, approvalHash: hashSchema, criteriaHash: hashSchema,
  cancellationRequested: z.boolean().default(false), source: z.object({ kind: z.string(), commit: z.string().nullable().optional() }).optional(),
  lastSequence: z.number().int().nonnegative().optional(),
  executionState: executionStateSchema.optional(),
  attempt: z.number().int().min(1).max(4).optional(),
});
export type RunControl = z.infer<typeof runControlSchema>;
type EventType = z.infer<typeof runEventSchema>["type"];

export class WorkerClient {
  token = "";
  expiresAt = 0;
  sequence = 0;
  control?: RunControl;
  usage: Record<string, number> = {};
  private eventTail: Promise<void> = Promise.resolve();
  readonly baseUrl: string;
  readonly runId: string;
  readonly oidcAudience: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly signal: AbortSignal;
  constructor(baseUrl: string, runId: string, oidcAudience: string, environment: NodeJS.ProcessEnv, signal: AbortSignal) {
    this.baseUrl = baseUrl; this.runId = runId; this.oidcAudience = oidcAudience; this.environment = environment; this.signal = signal;
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("DATA_WORKER_URL must be an HTTPS origin");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("Invalid run_id");
  }

  private async request(path: string, init: RequestInit = {}, refresh = true): Promise<Response> {
    if (refresh && Date.now() + 60000 >= this.expiresAt) await this.exchange();
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15000)]);
    return fetch(new URL(path, this.baseUrl), { ...init, redirect: "error", signal, headers: { ...(refresh ? { Authorization: `Bearer ${this.token}` } : {}), ...init.headers } });
  }

  async exchange(): Promise<RunControl> {
    const requestUrl = this.environment.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken = this.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) throw new Error("missing_secret: GitHub Actions OIDC environment is absent");
    const oidcUrl = new URL(requestUrl);
    // Never send the Actions request token to a configurable origin.
    if (oidcUrl.protocol !== "https:" || !oidcUrl.hostname.endsWith(".actions.githubusercontent.com")) throw new Error("Invalid Actions OIDC issuer request URL");
    oidcUrl.searchParams.set("audience", this.oidcAudience);
    const oidcResponse = await fetch(oidcUrl, { headers: { Authorization: `Bearer ${requestToken}` }, redirect: "error", signal: AbortSignal.any([this.signal, AbortSignal.timeout(10000)]) });
    if (!oidcResponse.ok) throw new Error(`service_unavailable: Actions OIDC HTTP ${oidcResponse.status}`);
    const oidc = z.object({ value: z.string().min(1) }).parse(await oidcResponse.json());
    let response: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      response = await this.request("/v1/runner/exchange", { method: "POST", headers: { Authorization: `Bearer ${oidc.value}`, "Content-Type": "application/json" }, body: JSON.stringify({ runId: this.runId }) }, false);
      if (response.status !== 409) break; // Dispatch attachment can race the first workflow step.
      await response.body?.cancel();
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!response) throw new Error("service_unavailable: Worker exchange failed");
    if (!response.ok) throw new Error(`service_unavailable: Worker OIDC exchange HTTP ${response.status}`);
    const result = z.object({ token: z.string().min(1), expiresAt: z.string().datetime(), run: runControlSchema, lastSequence: z.number().int().nonnegative().optional(), usage: z.record(z.string(), z.unknown()).optional() }).parse(await response.json());
    if (result.run.runId !== this.runId || await hashApprovalMaterial(result.run.approvalMaterial) !== result.run.approvalHash || result.run.taskId !== result.run.approvalMaterial.taskId) throw new Error("invalid_evidence: approved run identity mismatch");
    this.token = result.token; this.expiresAt = Date.parse(result.expiresAt); this.control = result.run;
    if (this.expiresAt <= Date.now() + 60000) throw new Error("service_unavailable: exchanged token expires too soon");
    this.sequence = Math.max(this.sequence, result.run.lastSequence ?? 0, result.lastSequence ?? 0);
    for (const [key, value] of Object.entries(result.usage ?? {})) if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.usage[key] = value;
    return result.run;
  }

  async poll(): Promise<RunControl> {
    const response = await this.request(`/v1/runs/${this.runId}`);
    if (!response.ok) throw new Error(`service_unavailable: runner control HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    const control = runControlSchema.parse(data.run ?? data);
    if (control.runId !== this.runId || control.approvalHash !== this.control?.approvalHash) throw new Error("invalid_evidence: run approval changed");
    this.sequence = Math.max(this.sequence, control.lastSequence ?? 0, typeof data.lastSequence === "number" ? data.lastSequence : 0);
    return control;
  }

  event(type: EventType, payload: Record<string, unknown>): Promise<void> {
    const event = runEventSchema.parse({ eventId: randomUUID(), runId: this.runId, sequence: ++this.sequence, occurredAt: new Date().toISOString(), type, payload });
    const send = async (): Promise<void> => {
      // The same envelope is retried, preserving idempotency after an ambiguous response.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.request(`/v1/runs/${this.runId}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
          if (response.ok) return;
          if (response.status < 500) throw new Error(`Worker event HTTP ${response.status}`);
        } catch (error) { if (attempt === 2 || this.signal.aborted) throw error; }
      }
      throw new Error("service_unavailable: Worker event retries exhausted");
    };
    const pending = this.eventTail.then(send);
    this.eventTail = pending.catch(() => {});
    return pending;
  }

  async source(): Promise<{ bytes?: Buffer; commit?: string; absent: boolean }> {
    const response = await this.request(`/v1/runs/${this.runId}/source`);
    if (response.status === 404) {
      const body = await response.json() as { code?: string; error?: { code?: string } | string; sourceCommit?: string; commit?: string };
      if ((body.code ?? (typeof body.error === "object" ? body.error?.code : body.error)) === "source_not_materialized") return { absent: true, commit: body.sourceCommit ?? body.commit };
    }
    if (!response.ok || !response.headers.get("Content-Type")?.includes("application/zip")) throw new Error(`service_unavailable: source archive HTTP ${response.status}`);
    const bytes = await boundedBytes(response, 32 * 1024 * 1024);
    if (sha256(bytes) !== response.headers.get("X-Source-SHA256")) throw new Error("invalid_evidence: source archive checksum mismatch");
    return { bytes, absent: false, commit: response.headers.get("X-Source-Commit") ?? undefined };
  }

  async checkpoint(): Promise<{ bytes: Buffer; sequence: number } | undefined> {
    const response = await this.request(`/v1/runs/${this.runId}/checkpoint`);
    if (response.status === 204 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`service_unavailable: checkpoint HTTP ${response.status}`);
    const bytes = await boundedBytes(response, 16 * 1024 * 1024);
    if (!bytes.length) return undefined;
    const sequence = Number(response.headers.get("X-Checkpoint-Sequence"));
    if (sha256(bytes) !== response.headers.get("X-Artifact-SHA256") || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid_evidence: checkpoint checksum/sequence mismatch");
    this.sequence = Math.max(this.sequence, sequence);
    return { bytes, sequence };
  }

  async artifact(bytes: Buffer, metadata: Record<string, unknown>): Promise<void> {
    const response = await this.request(`/v1/runs/${this.runId}/artifacts`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Artifact-Metadata": JSON.stringify(metadata) }, body: new Uint8Array(bytes) });
    if (!response.ok) throw new Error(`service_unavailable: artifact upload HTTP ${response.status}`);
  }

  async finish(executionState: "completed" | "failed" | "cancelled" | "interrupted", acceptanceOutcome: "passed" | "failed" | "inconclusive", summary: string): Promise<void> {
    await this.eventTail;
    const response = await this.request(`/v1/runs/${this.runId}/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executionState, acceptanceOutcome, summary }) });
    if (!response.ok) throw new Error(`service_unavailable: terminal update HTTP ${response.status}`);
  }
}
