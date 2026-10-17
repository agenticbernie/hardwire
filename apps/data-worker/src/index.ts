import { z } from 'zod';
import { acceptanceOutcomeSchema, approvalMaterialSchema, archiveManifestSchema, artifactUploadMetadataSchema, criterionResultSchema, executionStateSchema, hashApprovalMaterial, runEventSchema } from '../../../packages/contracts/src/index.ts';
import { authenticate, mintSession, validateOidc } from './auth.ts';
import { canonical, MAX_ARCHIVE, readZip, safePath, validateArchive, validatePng, writeZip } from './archive.ts';
import { boundedBytes, HttpError, json, requireCondition, retention, sha256 } from './types.ts';
import type { Env, Row, Statement } from './types.ts';
import { fetchSnapshot,SNAPSHOT_COMMIT } from './snapshot.ts';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const POC_BUDGET_USD = 10;
const encoder = new TextEncoder();
const iso = (time: number | null): string | null => time === null ? null : new Date(time).toISOString();
const hashValue = (value: unknown) => sha256(encoder.encode(canonical(value)));
const idSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const sourceSchema = z.object({ kind: z.literal('gunny-snapshot'), commit: z.literal(SNAPSHOT_COMMIT) }).strict();
const artifactInput = artifactUploadMetadataSchema.extend({ artifactId: idSchema.optional() });

async function body(request: Request): Promise<any> {
  try { return JSON.parse(new TextDecoder().decode(await boundedBytes(request, 1024 * 1024))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json'); }
}
function cleanPayload(value: unknown): void {
  const text = JSON.stringify(value);
  requireCondition(text.length <= 256000 && !/(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(text), 400, 'sensitive_or_oversized_payload');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    requireCondition(!/^(?:authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|sourceCode)$/i.test(key), 400, 'sensitive_payload_field');
    cleanPayload(child);
  }
}
async function project(env: Env, id: string, owner: string): Promise<Row> {
  const row = await env.DB.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').bind(id, owner).first<Row>();
  requireCondition(row, 404, 'project_not_found');
  requireCondition(row.expires_at > Date.now() && !row.deleted_at, 410, 'project_expired');
  return row;
}
async function getRun(env: Env, id: string, owner?: string): Promise<Row> {
  const row = await env.DB.prepare('SELECT r.*,p.expires_at AS project_expires_at,p.deleted_at FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=?').bind(id).first<Row>();
  requireCondition(row && (!owner || owner === row.owner_id), 404, 'run_not_found');
  requireCondition(row.expires_at > Date.now() && row.project_expires_at > Date.now() && !row.deleted_at, 410, 'run_expired');
  return row;
}
async function getTask(env: Env, id: string, owner: string, version?: number): Promise<Row> {
  const row = await env.DB.prepare(`SELECT t.*,p.owner_id,p.source_json,p.expires_at,p.deleted_at FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.owner_id=? ${version ? 'AND t.version=?' : ''} ORDER BY t.version DESC LIMIT 1`).bind(...(version ? [id, owner, version] : [id, owner])).first<Row>();
  requireCondition(row, 404, 'task_not_found');
  requireCondition(row.expires_at > Date.now() && !row.deleted_at, 410, 'task_expired');
  return row;
}
function taskView(row: Row): Row {
  return { ...JSON.parse(row.material_json), id: row.id, taskId: row.id, version: row.version, taskVersion: row.version, projectId: row.project_id, approvalHash: row.approval_hash, criteriaHash: row.criteria_hash, approvedAt: iso(row.approved_at), source: row.source_json ? JSON.parse(row.source_json) : undefined };
}
function runView(row: Row): Row {
  return { id: row.id, runId: row.id, projectId: row.project_id, taskId: row.task_id, taskVersion: row.task_version,
    approvalHash: row.approval_hash, criteriaHash: row.criteria_hash, executionState: row.execution_state, acceptanceOutcome: row.acceptance_outcome,
    reason: row.reason, workflowRunId: row.workflow_run_id, workflowUrl: row.workflow_url,
    cancelRequested: Boolean(row.cancel_requested), cancellationRequested: Boolean(row.cancel_requested),
    attempt: row.current_attempt, lastSequence:row.last_event_seq, createdAt: iso(row.created_at), endedAt: iso(row.ended_at), expiresAt: iso(row.expires_at) };
}
async function usage(env: Env, runId?: string, owner?: string): Promise<Row> {
  if (!runId) {
    requireCondition(owner,500,'usage_owner_required');
    const total=await env.DB.prepare('SELECT * FROM poc_usage_totals WHERE owner_id=?').bind(owner).first<Row>();
    const cost=Number(total?.cost_usd??0),steps=Number(total?.steps??0);
    const providerUsageMeasured=steps>0||Number(total?.input_tokens??0)>0||Number(total?.output_tokens??0)>0||Number(total?.reasoning_tokens??0)>0||Number(total?.cache_read_tokens??0)>0||Number(total?.cache_write_tokens??0)>0||cost>0;
    return {
      inputTokens:Number(total?.input_tokens??0),outputTokens:Number(total?.output_tokens??0),
      reasoningTokens:Number(total?.reasoning_tokens??0),cacheReadTokens:Number(total?.cache_read_tokens??0),
      cacheWriteTokens:Number(total?.cache_write_tokens??0),steps,calls:Number(total?.calls??0),costUsd:cost,
      actionsSeconds:Number(total?.actions_seconds??0),wokwiSeconds:Number(total?.wokwi_seconds??0),
      artifactBytes:Number(total?.artifact_bytes??0),runCount:Number(total?.run_count??0),
      providerUsageMeasured,reportedCostUsd:cost,estimatedCostUsd:cost,
      githubActionsSeconds:Number(total?.actions_seconds??0),hardDollarCapVerified:false,
      scope:'poc_lifetime',pocBudgetUsd:POC_BUDGET_USD,
      pocBudgetRemainingUsd:Math.max(0,POC_BUDGET_USD-cost),
      budgetAdmissionEnforced:true,budgetEnforcement:'measured_usage_plus_approved_run_reservation',
    };
  }
  const groups = (await env.DB.prepare(`SELECT COALESCE(SUM(u.input_tokens),0) AS inputTokens, COALESCE(SUM(u.output_tokens),0) AS outputTokens, COALESCE(SUM(u.reasoning_tokens),0) AS reasoningTokens, COALESCE(SUM(u.cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(u.cache_write_tokens),0) AS cacheWriteTokens, COALESCE(SUM(u.steps),0) AS steps, COALESCE(SUM(u.calls),0) AS calls, COALESCE(SUM(u.cost_usd),0) AS costUsd, COALESCE(SUM(CASE WHEN u.cumulative=0 THEN u.actions_seconds ELSE 0 END),0) + COALESCE(MAX(CASE WHEN u.cumulative=1 THEN u.actions_seconds ELSE 0 END),0) AS actionsSeconds, COALESCE(SUM(CASE WHEN u.cumulative=0 THEN u.wokwi_seconds ELSE 0 END),0) + COALESCE(MAX(CASE WHEN u.cumulative=1 THEN u.wokwi_seconds ELSE 0 END),0) AS wokwiSeconds FROM usage u JOIN runs r ON r.id=u.run_id ${runId ? 'WHERE r.id=?' : 'WHERE r.owner_id=?'} GROUP BY r.id`).bind(runId ?? owner).all<Row>()).results;
  const keys=['inputTokens','outputTokens','reasoningTokens','cacheReadTokens','cacheWriteTokens','steps','calls','costUsd','actionsSeconds','wokwiSeconds'];
  const row:Row=Object.fromEntries(keys.map(key=>[key,groups.reduce((sum,group)=>sum+Number(group[key]??0),0)]));
  const objects = await env.DB.prepare(`SELECT COALESCE(SUM(a.byte_size),0) AS total FROM artifacts a JOIN runs r ON r.id=a.run_id ${runId?'WHERE r.id=?':'WHERE r.owner_id=?'}`).bind(runId??owner).first<Row>();
  const providerUsageMeasured=Number(row.steps??0)>0||Number(row.inputTokens??0)>0||Number(row.outputTokens??0)>0||Number(row.reasoningTokens??0)>0||Number(row.cacheReadTokens??0)>0||Number(row.cacheWriteTokens??0)>0||Number(row.costUsd??0)>0;
  return { ...row, artifactBytes:objects?.total??0, providerUsageMeasured, reportedCostUsd:row.costUsd, estimatedCostUsd:row.costUsd, githubActionsSeconds: row?.actionsSeconds ?? 0, hardDollarCapVerified: false, scope:'run' };
}
async function snapshot(env: Env, run: Row): Promise<Row> {
  const task = taskView(await getTask(env, run.task_id, run.owner_id, run.task_version));
  const artifacts = (await env.DB.prepare('SELECT metadata_json FROM artifacts WHERE run_id=? AND expires_at>? AND verified=1 ORDER BY created_at').bind(run.id, Date.now()).all<Row>()).results.map(row => JSON.parse(row.metadata_json));
  const criteria = (await env.DB.prepare('SELECT result_json FROM test_results WHERE run_id=? AND attempt=?').bind(run.id, run.current_attempt).all<Row>()).results.map(row => JSON.parse(row.result_json));
  const attemptRows=(await env.DB.prepare('SELECT attempt,state,source_hash,firmware_hash,scenario_hash,created_at FROM attempts WHERE run_id=? ORDER BY attempt').bind(run.id).all<Row>()).results;
  const attempts=attemptRows.map((attempt,index)=>({attempt:attempt.attempt,executionState:attempt.state,sourceHash:attempt.source_hash,firmwareHash:attempt.firmware_hash,scenarioHash:attempt.scenario_hash,startedAt:iso(attempt.created_at),finishedAt:attemptRows[index+1]?iso(attemptRows[index+1].created_at):terminal.has(run.execution_state)?iso(run.ended_at):null}));
  const measuredUsage=await usage(env,run.id);
  return { run: { ...runView(run), approvalMaterial: JSON.parse((await getTask(env, run.task_id, run.owner_id, run.task_version)).material_json), source: task.source, usage:measuredUsage }, task, usage: measuredUsage, criteria, attempts, artifacts, lastSequence: run.last_event_seq };
}

async function saveEvent(env: Env, run: Row, input: unknown): Promise<Response> {
  const event = runEventSchema.parse(input);
  requireCondition(event.runId === run.id, 403, 'event_run_mismatch');
  cleanPayload(event.payload);
  const eventHash = await hashValue(event);
  const duplicate = await env.DB.prepare('SELECT event_hash,run_id FROM events WHERE id=?').bind(event.eventId).first<Row>();
  if (duplicate) {
    requireCondition(duplicate.run_id === run.id && duplicate.event_hash === eventHash, 409, 'event_id_conflict');
    return json({ accepted: true, duplicate: true, sequence: event.sequence });
  }
  requireCondition(!terminal.has(run.execution_state), 409, 'terminal_run');
  requireCondition(event.sequence > run.last_event_seq, 409, 'event_sequence_conflict');
  const now = Date.now();
  const statements = [env.DB.prepare('INSERT INTO events(id,run_id,sequence,event_json,event_hash,type,occurred_at,created_at,expires_at,workflow_run_id) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(event.eventId,run.id,event.sequence,JSON.stringify(event),eventHash,event.type,event.occurredAt,now,run.expires_at,run.workflow_run_id)];
  if (event.type === 'state') {
    const state = executionStateSchema.parse(event.payload.state);
    requireCondition(!terminal.has(state), 400, 'finish_required_for_terminal_state');
    const attempt = z.number().int().min(run.current_attempt).max(4).parse(event.payload.attempt ?? run.current_attempt);
    const task = JSON.parse((await getTask(env,run.task_id,run.owner_id,run.task_version)).material_json);
    requireCondition(attempt <= task.limits.maxRepairRounds + 1 && attempt <= run.current_attempt + 1, 409, 'repair_limit');
    statements.push(env.DB.prepare('UPDATE runs SET execution_state=?,current_attempt=? WHERE id=?').bind(state,attempt,run.id));
    statements.push(env.DB.prepare('INSERT INTO attempts(run_id,attempt,state,created_at) VALUES(?,?,?,?) ON CONFLICT(run_id,attempt) DO UPDATE SET state=excluded.state').bind(run.id,attempt,state,now));
  }
  if (event.type === 'usage') {
    const values = z.object({ inputTokens:z.number().int().nonnegative().default(0),outputTokens:z.number().int().nonnegative().default(0),reasoningTokens:z.number().int().nonnegative().default(0),cacheReadTokens:z.number().int().nonnegative().default(0),cacheWriteTokens:z.number().int().nonnegative().default(0),steps:z.number().int().nonnegative().default(0),calls:z.number().int().nonnegative().default(0),costUsd:z.number().nonnegative().default(0),actionsSeconds:z.number().nonnegative().default(0),wokwiSeconds:z.number().nonnegative().default(0),artifactBytes:z.number().int().nonnegative().default(0),cumulative:z.boolean().default(false) }).parse(event.payload);
    const previous=await env.DB.prepare('SELECT COALESCE(SUM(CASE WHEN cumulative=0 THEN actions_seconds ELSE 0 END),0)+COALESCE(MAX(CASE WHEN cumulative=1 THEN actions_seconds END),0) AS actionsSeconds,COALESCE(SUM(CASE WHEN cumulative=0 THEN wokwi_seconds ELSE 0 END),0)+COALESCE(MAX(CASE WHEN cumulative=1 THEN wokwi_seconds END),0) AS wokwiSeconds FROM usage WHERE run_id=?').bind(run.id).first<Row>();
    const actionsDelta=values.cumulative?Math.max(0,values.actionsSeconds-Number(previous?.actionsSeconds??0)):values.actionsSeconds;
    const wokwiDelta=values.cumulative?Math.max(0,values.wokwiSeconds-Number(previous?.wokwiSeconds??0)):values.wokwiSeconds;
    statements.push(env.DB.prepare('INSERT INTO usage(event_id,run_id,input_tokens,output_tokens,cost_usd,actions_seconds,wokwi_seconds,artifact_bytes,reasoning_tokens,cache_read_tokens,cache_write_tokens,steps,calls,cumulative) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(event.eventId,run.id,values.inputTokens,values.outputTokens,values.costUsd,values.actionsSeconds,values.wokwiSeconds,values.artifactBytes,values.reasoningTokens,values.cacheReadTokens,values.cacheWriteTokens,values.steps,values.calls,values.cumulative?1:0));
    statements.push(env.DB.prepare('INSERT INTO poc_usage_totals(owner_id,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,steps,calls,cost_usd,actions_seconds,wokwi_seconds,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens,cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,steps=steps+excluded.steps,calls=calls+excluded.calls,cost_usd=cost_usd+excluded.cost_usd,actions_seconds=actions_seconds+excluded.actions_seconds,wokwi_seconds=wokwi_seconds+excluded.wokwi_seconds,updated_at=excluded.updated_at').bind(run.owner_id,values.inputTokens,values.outputTokens,values.reasoningTokens,values.cacheReadTokens,values.cacheWriteTokens,values.steps,values.calls,values.costUsd,actionsDelta,wokwiDelta,now));
  }
  if (event.type === 'checkpoint') {
    const artifact = await env.DB.prepare("SELECT * FROM artifacts WHERE id=? AND run_id=? AND kind='checkpoint' AND verified=1 AND expires_at>?").bind(event.payload.artifactId,run.id,now).first<Row>();
    requireCondition(artifact && artifact.sha256 === event.payload.sha256 && artifact.attempt === run.current_attempt,422,'invalid_checkpoint_reference');
    requireCondition(JSON.parse(artifact.metadata_json).sourceHash === event.payload.sourceHash,422,'checkpoint_identity_mismatch');
    statements.push(env.DB.prepare('UPDATE artifacts SET checkpoint_sequence=? WHERE id=? AND checkpoint_sequence IS NULL').bind(event.sequence,artifact.id));
  }
  if (event.type === 'criterion') {
    const { attempt: suppliedAttempt, ...raw } = event.payload;
    const attempt = suppliedAttempt ?? run.current_attempt;
    requireCondition(attempt === run.current_attempt, 409, 'criterion_attempt_mismatch');
    const result = criterionResultSchema.parse(raw);
    const task = await getTask(env,run.task_id,run.owner_id,run.task_version);
    const criterion = JSON.parse(task.material_json).criteria.find((item: Row) => item.id === result.criterionId);
    requireCondition(criterion && result.criteriaHash === run.criteria_hash, 422, 'criterion_identity_mismatch');
    const kinds = new Set<string>();
    for (const id of result.evidenceIds) {
      const artifact = await env.DB.prepare('SELECT * FROM artifacts WHERE id=? AND run_id=? AND verified=1 AND expires_at>?').bind(id,run.id,now).first<Row>();
      requireCondition(artifact && artifact.attempt === attempt, 422, 'invalid_criterion_evidence');
      const evidence = JSON.parse(artifact.metadata_json);
      requireCondition(evidence.sourceHash === result.sourceHash && evidence.firmwareHash === result.firmwareHash && evidence.scenarioHash === result.scenarioHash && evidence.criteriaHash === result.criteriaHash, 422, 'criterion_identity_mismatch');
      kinds.add(artifact.kind);
    }
    if (result.outcome === 'passed') requireCondition(criterion.evidence.every((kind: string) => kinds.has(kind)), 422, 'criterion_missing_evidence');
    statements.push(env.DB.prepare('INSERT INTO test_results(run_id,attempt,criterion_id,outcome,result_json,event_id) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,attempt,criterion_id) DO UPDATE SET outcome=excluded.outcome,result_json=excluded.result_json,event_id=excluded.event_id').bind(run.id,attempt,result.criterionId,result.outcome,JSON.stringify(result),event.eventId));
  }
  try { await env.DB.batch(statements); }
  catch {
    const saved = await env.DB.prepare('SELECT event_hash FROM events WHERE id=? AND run_id=?').bind(event.eventId,run.id).first<Row>();
    requireCondition(saved?.event_hash === eventHash, 409, 'event_sequence_conflict');
    return json({ accepted: true, duplicate: true, sequence:event.sequence });
  }
  return json({ accepted:true,duplicate:false,sequence:event.sequence });
}

async function uploadArtifact(request: Request, env: Env, run: Row): Promise<Response> {
  requireCondition(!terminal.has(run.execution_state),409,'terminal_run');
  let raw: unknown;
  try { raw = JSON.parse(request.headers.get('x-artifact-metadata') ?? ''); } catch { throw new HttpError(400,'invalid_artifact_metadata'); }
  const input = artifactInput.parse(raw);
  cleanPayload(input);
  requireCondition(input.runId === run.id && input.criteriaHash === run.criteria_hash && input.attempt === run.current_attempt,422,'artifact_identity_mismatch');
  const bytes = await boundedBytes(request,MAX_ARCHIVE);
  requireCondition(input.byteSize === bytes.byteLength && input.sha256 === await sha256(bytes),422,'artifact_checksum_mismatch');
  if (input.kind === 'screenshot') { requireCondition(input.mediaType === 'image/png',422,'invalid_png_media_type'); await validatePng(bytes); }
  if (input.kind === 'checkpoint') await checkpointFiles(bytes,run,input);
  if (/^(?:text\/|application\/json)/.test(input.mediaType)) cleanPayload(new TextDecoder().decode(bytes));
  const id = input.artifactId ?? crypto.randomUUID();
  const key = `projects/${run.project_id}/runs/${run.id}/${id}`;
  const metadata = {...input,artifactId:id,r2Key:key};
  const existing = await env.DB.prepare('SELECT * FROM artifacts WHERE id=?').bind(id).first<Row>();
  if (existing) {
    requireCondition(existing.run_id === run.id && canonical(JSON.parse(existing.metadata_json)) === canonical(metadata),409,'artifact_id_conflict');
    return json({artifact:metadata,created:false});
  }
  await env.ARTIFACTS.put(key,bytes,{httpMetadata:{contentType:input.mediaType}});
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO artifacts(id,run_id,project_id,attempt,kind,r2_key,metadata_json,sha256,byte_size,verified,created_at,expires_at,workflow_run_id) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)')
        .bind(id,run.id,run.project_id,input.attempt,input.kind,key,JSON.stringify(metadata),input.sha256,input.byteSize,Date.now(),run.expires_at,run.workflow_run_id),
      env.DB.prepare('UPDATE attempts SET source_hash=?,firmware_hash=?,scenario_hash=? WHERE run_id=? AND attempt=?').bind(input.sourceHash,input.firmwareHash,input.scenarioHash,run.id,input.attempt),
      env.DB.prepare('UPDATE poc_usage_totals SET artifact_bytes=artifact_bytes+?,updated_at=? WHERE owner_id=?').bind(input.byteSize,Date.now(),run.owner_id),
    ]);
  } catch (error) { /* Private unreferenced objects are reclaimed by project-prefix cleanup. */ throw error; }
  return json({artifact:metadata,created:true},201);
}

async function finish(env: Env, run: Row, input: any): Promise<Response> {
  const state = z.enum(['completed','failed','cancelled','interrupted']).parse(input.executionState);
  const outcome = acceptanceOutcomeSchema.parse(input.acceptanceOutcome);
  const summary = z.string().max(10000).parse(input.summary ?? input.reason ?? '');
  cleanPayload(summary);
  if (terminal.has(run.execution_state)) {
    requireCondition(run.execution_state === state && run.acceptance_outcome === outcome,409,'terminal_run_conflict');
    return json({run:runView(run)});
  }
  if (outcome !== 'inconclusive') {
    requireCondition(state === 'completed',422,'invalid_acceptance_execution');
    const task = JSON.parse((await getTask(env,run.task_id,run.owner_id,run.task_version)).material_json);
    const results = (await env.DB.prepare('SELECT criterion_id,outcome FROM test_results WHERE run_id=? AND attempt=?').bind(run.id,run.current_attempt).all<Row>()).results;
    const required = task.criteria.filter((criterion: Row) => criterion.required);
    const derived = required.some((criterion: Row) => results.some(row => row.criterion_id === criterion.id && row.outcome === 'failed')) ? 'failed'
      : required.length > 0 && required.every((criterion: Row) => results.some(row => row.criterion_id === criterion.id && row.outcome === 'passed')) ? 'passed' : 'inconclusive';
    requireCondition(outcome === derived,422,'acceptance_requires_evaluator_results');
  }
  const now = Date.now(), expires = now + retention(env), finishId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("UPDATE runs SET execution_state=?,acceptance_outcome=?,reason=?,ended_at=?,expires_at=?,finish_id=? WHERE id=? AND workflow_run_id IS ? AND execution_state NOT IN ('completed','failed','cancelled','interrupted')").bind(state,outcome,summary,now,expires,finishId,run.id,run.workflow_run_id),
    env.DB.prepare('UPDATE projects SET expires_at=? WHERE id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND finish_id=?)').bind(expires,run.project_id,run.id,finishId),
    env.DB.prepare('UPDATE events SET expires_at=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND finish_id=?)').bind(expires,run.id,run.id,finishId),
    env.DB.prepare('UPDATE artifacts SET expires_at=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND finish_id=?)').bind(expires,run.id,run.id,finishId),
    env.DB.prepare('UPDATE attempts SET state=? WHERE run_id=? AND attempt=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND finish_id=?)').bind(state,run.id,run.current_attempt,run.id,finishId),
    env.DB.prepare('UPDATE workflow_bindings SET ended_at=?,execution_state=? WHERE workflow_run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND finish_id=?)').bind(now,state,run.workflow_run_id,run.id,finishId),
  ]);
  const saved = await getRun(env,run.id,run.owner_id);
  requireCondition(saved.execution_state === state && saved.acceptance_outcome === outcome,409,'terminal_run_conflict');
  return json({run:runView(saved)});
}

async function objectResponse(env: Env, key: string, hash: string, size: number, mediaType: string, headers: Record<string,string> = {}): Promise<Response> {
  const object = await env.ARTIFACTS.get(key);
  requireCondition(object && object.size === size,422,'object_missing_or_invalid');
  const bytes = new Uint8Array(await object.arrayBuffer());
  requireCondition(await sha256(bytes) === hash,422,'object_checksum_mismatch');
  return new Response(bytes,{headers:{'content-type':mediaType,'content-length':String(bytes.length),'cache-control':'no-store','x-content-type-options':'nosniff','x-artifact-sha256':hash,...headers}});
}

async function checkpointFiles(bytes: Uint8Array<ArrayBuffer>, run: Row, metadata: Row): Promise<Map<string,Uint8Array<ArrayBuffer>>> {
  let checkpoint: any;
  try { checkpoint=JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(422,'invalid_checkpoint'); }
  requireCondition(checkpoint.format==='hardwire-checkpoint' && checkpoint.formatVersion===1 && checkpoint.runId===run.id && checkpoint.approvalHash===run.approval_hash && checkpoint.criteriaHash===run.criteria_hash && checkpoint.attempt===metadata.attempt && checkpoint.sourceHash===metadata.sourceHash && checkpoint.files && typeof checkpoint.files==='object' && !Array.isArray(checkpoint.files),422,'checkpoint_identity_mismatch');
  const files=new Map<string,Uint8Array<ArrayBuffer>>();
  let total=0;
  const hashes: [string,string][]=[];
  for(const [path,value] of Object.entries(checkpoint.files).sort(([a],[b])=>a.localeCompare(b))) {
    safePath(path);
    requireCondition(typeof value==='string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),422,'invalid_checkpoint_file');
    const decoded=Uint8Array.from(atob(value),char=>char.charCodeAt(0));
    total+=decoded.length;requireCondition(decoded.length<=8*1024*1024 && total<=16*1024*1024 && files.size<1500,413,'checkpoint_source_limit');
    if(/\.(?:json|txt|log|md|ini|toml|ya?ml|[ch](?:pp)?|js|ts|py)$/i.test(path)) cleanPayload(new TextDecoder().decode(decoded));
    hashes.push([path,await sha256(decoded)]);files.set(path,decoded);
  }
  requireCondition(files.size>0 && await sha256(encoder.encode(JSON.stringify(hashes)))===metadata.sourceHash,422,'checkpoint_source_hash_mismatch');
  return files;
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/v1/runner/exchange' && request.method === 'POST') {
    const input = z.object({runId:idSchema}).strict().parse(await body(request));
    const run = await getRun(env,input.runId);
    requireCondition(!terminal.has(run.execution_state) && run.workflow_run_id,409,'run_not_dispatched');
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    requireCondition(token,401,'oidc_required');
    const claims = await validateOidc(token,env,run);
    return json({...await mintSession(env,run,claims),...await snapshot(env,run)});
  }
  const match = path.match(/^\/v1\/runs\/([a-zA-Z0-9_-]+)(?:\/(workflow|events|artifacts|checkpoint|finish|cancel|reconcile|source|resume))?$/);
  if (match) {
    const auth = await authenticate(request,env,match[1]);
    const run = await getRun(env,match[1]!,auth.ownerId);
    const action = match[2];
    if (!action && request.method === 'GET') return json(await snapshot(env,run));
    if (['workflow','cancel','reconcile','resume'].includes(action ?? '')) requireCondition(!auth.runner,403,'service_auth_required');
    if (['events','artifacts','finish'].includes(action ?? '')) requireCondition(auth.runner,403,'runner_auth_required');
    if (action === 'events' && request.method === 'POST') return saveEvent(env,run,await body(request));
    if (action === 'artifacts' && request.method === 'POST') return uploadArtifact(request,env,run);
    if (action === 'finish' && request.method === 'POST') return finish(env,run,await body(request));
    if (action === 'resume' && request.method === 'POST') {
      const input=z.object({idempotencyKey:z.string().min(8).max(200)}).strict().parse(await body(request));
      const prior=await env.DB.prepare('SELECT * FROM resume_requests WHERE run_id=? AND idempotency_key=?').bind(run.id,input.idempotencyKey).first<Row>();
      if(prior) return json({created:false,runId:run.id,executionState:run.execution_state,run:runView(run)});
      requireCondition(run.execution_state==='interrupted',409,'resume_requires_interrupted_run');
      const checkpoint=await env.DB.prepare("SELECT * FROM artifacts WHERE run_id=? AND kind='checkpoint' AND verified=1 AND checkpoint_sequence IS NOT NULL AND expires_at>? ORDER BY checkpoint_sequence DESC LIMIT 1").bind(run.id,Date.now()).first<Row>();
      requireCondition(checkpoint,409,'resume_requires_verified_checkpoint');
      const object=await env.ARTIFACTS.get(checkpoint.r2_key);requireCondition(object,422,'checkpoint_missing');
      const bytes=new Uint8Array(await object.arrayBuffer());requireCondition(bytes.length===checkpoint.byte_size&&await sha256(bytes)===checkpoint.sha256,422,'checkpoint_checksum_mismatch');
      await checkpointFiles(bytes,run,JSON.parse(checkpoint.metadata_json));
      // A resumed workflow gets a bounded execution lease; terminal finish restores end + retention.
      const resumeLease=Math.max(Date.now()+31*60_000,run.expires_at,run.project_expires_at);
      try {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO resume_requests(run_id,idempotency_key,created_at,prior_workflow_run_id,prior_ended_at,checkpoint_sequence) VALUES(?,?,?,?,?,?)').bind(run.id,input.idempotencyKey,Date.now(),run.workflow_run_id,run.ended_at,checkpoint.checkpoint_sequence),
          env.DB.prepare("UPDATE runs SET execution_state='queued',acceptance_outcome=NULL,reason=NULL,ended_at=NULL,finish_id=NULL,workflow_run_id=NULL,workflow_url=NULL,cancel_requested=0,expires_at=? WHERE id=? AND execution_state='interrupted' AND EXISTS(SELECT 1 FROM resume_requests WHERE run_id=? AND idempotency_key=?)").bind(resumeLease,run.id,run.id,input.idempotencyKey),
          env.DB.prepare("UPDATE projects SET expires_at=MAX(expires_at,?) WHERE id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND execution_state='queued')").bind(resumeLease,run.project_id,run.id),
          env.DB.prepare("UPDATE artifacts SET expires_at=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND execution_state='queued')").bind(resumeLease,run.id,run.id),
          env.DB.prepare("UPDATE events SET expires_at=? WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND execution_state='queued')").bind(resumeLease,run.id,run.id),
          env.DB.prepare("DELETE FROM runner_sessions WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND execution_state='queued')").bind(run.id,run.id),
        ]);
      } catch {
        const claimed=await env.DB.prepare('SELECT run_id FROM resume_requests WHERE run_id=? AND idempotency_key=?').bind(run.id,input.idempotencyKey).first<Row>();
        if(claimed) {const saved=await getRun(env,run.id,auth.ownerId);return json({created:false,runId:run.id,executionState:saved.execution_state,run:runView(saved)});}
        throw new HttpError(409,'active_run_or_resume_conflict');
      }
      const saved=await getRun(env,run.id,auth.ownerId);
      requireCondition(saved.execution_state==='queued'&&!saved.workflow_run_id,409,'resume_conflict');
      return json({created:true,runId:run.id,executionState:'queued',run:runView(saved)});
    }
    if (action === 'workflow' && request.method === 'POST') {
      const input = z.object({workflowRunId:z.string().regex(/^\d+$/),workflowUrl:z.string().url()}).strict().parse(await body(request));
      requireCondition(input.workflowUrl === `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${input.workflowRunId}`,400,'invalid_workflow_url');
      requireCondition(!run.workflow_run_id || run.workflow_run_id === input.workflowRunId,409,'workflow_already_attached');
      const historical=await env.DB.prepare('SELECT run_id FROM workflow_bindings WHERE workflow_run_id=?').bind(input.workflowRunId).first<Row>();
      requireCondition(!historical||run.workflow_run_id===input.workflowRunId,409,'workflow_id_already_used');
      requireCondition(!terminal.has(run.execution_state),409,'terminal_run');
      await env.DB.batch([
        env.DB.prepare('UPDATE runs SET workflow_run_id=?,workflow_url=? WHERE id=? AND (workflow_run_id IS NULL OR workflow_run_id=?)').bind(input.workflowRunId,input.workflowUrl,run.id,input.workflowRunId),
        env.DB.prepare('INSERT OR IGNORE INTO workflow_bindings(workflow_run_id,run_id,workflow_url,attached_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND workflow_run_id=?)').bind(input.workflowRunId,run.id,input.workflowUrl,Date.now(),run.id,input.workflowRunId),
      ]);
      const saved = await getRun(env,run.id,auth.ownerId);
      requireCondition(saved.workflow_run_id === input.workflowRunId,409,'workflow_already_attached');
      return json({run:runView(saved)});
    }
    if (action === 'cancel' && request.method === 'POST') {
      await env.DB.prepare('UPDATE runs SET cancel_requested=1 WHERE id=?').bind(run.id).run();
      return json({run:runView(await getRun(env,run.id,auth.ownerId))});
    }
    if (action === 'reconcile' && request.method === 'POST') {
      const input = z.object({workflowRunId:z.string(),status:z.literal('completed'),conclusion:z.string()}).parse(await body(request));
      requireCondition(input.workflowRunId === run.workflow_run_id,409,'workflow_run_mismatch');
      if (terminal.has(run.execution_state)) return json({run:runView(run)});
      return finish(env,run,{executionState:input.conclusion === 'cancelled' ? 'cancelled':'interrupted',acceptanceOutcome:'inconclusive',summary:'runner_lost'});
    }
    if (action === 'checkpoint' && request.method === 'GET') {
      const artifact = await env.DB.prepare("SELECT * FROM artifacts WHERE run_id=? AND kind='checkpoint' AND verified=1 AND checkpoint_sequence IS NOT NULL AND expires_at>? ORDER BY checkpoint_sequence DESC LIMIT 1").bind(run.id,Date.now()).first<Row>();
      if (!artifact) return new Response(null,{status:204,headers:{'cache-control':'no-store'}});
      return objectResponse(env,artifact.r2_key,artifact.sha256,artifact.byte_size,JSON.parse(artifact.metadata_json).mediaType,{'x-checkpoint-sequence':String(artifact.checkpoint_sequence)});
    }
    if (action === 'source' && request.method === 'GET') {
      const source = await env.DB.prepare("SELECT * FROM project_files WHERE project_id=? AND path='__source_archive'").bind(run.project_id).first<Row>();
      const p = await project(env,run.project_id,auth.ownerId);
      const commit = JSON.parse(p.source_json).commit ?? '';
      if (!source) return json({code:'source_not_materialized',commit},404);
      return objectResponse(env,source.r2_key,source.sha256,source.byte_size,'application/zip',{'x-source-sha256':source.sha256,'x-source-commit':commit});
    }
    throw new HttpError(405,'method_not_allowed');
  }
  const download = path.match(/^\/v1\/artifacts\/([a-zA-Z0-9_-]+)$/);
  if (download && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM artifacts WHERE id=?').bind(download[1]).first<Row>();
    requireCondition(row,404,'artifact_not_found');
    const auth = await authenticate(request,env,row.run_id);
    await getRun(env,row.run_id,auth.ownerId);
    requireCondition(row.expires_at > Date.now() && row.verified,410,'artifact_expired');
    return objectResponse(env,row.r2_key,row.sha256,row.byte_size,JSON.parse(row.metadata_json).mediaType,{'content-disposition':`attachment; filename="${row.id}"`});
  }
  const auth = await authenticate(request,env);
  requireCondition(!auth.runner,403,'service_auth_required');
  if (path === '/v1/projects' && request.method === 'GET') {
    const projects = (await env.DB.prepare('SELECT * FROM projects WHERE owner_id=? AND expires_at>? AND deleted_at IS NULL ORDER BY created_at DESC').bind(auth.ownerId,Date.now()).all<Row>()).results;
    return json({projects:await Promise.all(projects.map(p=>projectView(env,p)))});
  }
  const projectMatch = path.match(/^\/v1\/projects\/([a-zA-Z0-9_-]+)$/);
  if (projectMatch && request.method === 'GET') return json({project:await projectView(env,await project(env,projectMatch[1]!,auth.ownerId))});
  if (path === '/v1/projects' && request.method === 'POST') {
    const input = z.object({id:idSchema.optional(),name:z.string().min(1).max(160),source:sourceSchema}).strict().parse(await body(request));
    const id = input.id ?? crypto.randomUUID(), now = Date.now(), expires = now + retention(env);
    await env.DB.prepare('INSERT INTO projects(id,owner_id,name,source_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,auth.ownerId,input.name,JSON.stringify(input.source),now,expires).run();
    return json({project:{id,ownerId:auth.ownerId,name:input.name,source:input.source,expiresAt:iso(expires)}},201);
  }
  if (path === '/v1/tasks' && request.method === 'POST') {
    const input = await body(request);
    const p = await project(env,idSchema.parse(input.projectId),auth.ownerId);
    const id = idSchema.parse(input.taskId ?? crypto.randomUUID());
    const material = approvalMaterialSchema.parse({taskId:id,taskVersion:input.version,objective:input.objective,allowedPaths:input.allowedPaths,limits:input.limits,criteria:input.criteria});
    requireCondition(new Set(material.criteria.map(c => c.id)).size === material.criteria.length,400,'duplicate_criterion_id');
    const hash = await hashApprovalMaterial(material), criteriaHash = await hashValue(material.criteria);
    const existing = await env.DB.prepare('SELECT project_id FROM tasks WHERE id=? LIMIT 1').bind(id).first<Row>();
    requireCondition(!existing || existing.project_id === p.id,409,'task_project_conflict');
    try { await env.DB.batch([
      env.DB.prepare('INSERT INTO tasks(id,version,project_id,material_json,approval_hash,criteria_hash,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,material.taskVersion,p.id,JSON.stringify(material),hash,criteriaHash,Date.now()),
      ...material.criteria.map(c => env.DB.prepare('INSERT INTO criteria(task_id,task_version,id,required,definition_json) VALUES(?,?,?,?,?)').bind(id,material.taskVersion,c.id,c.required?1:0,JSON.stringify(c))),
    ]); } catch { throw new HttpError(409,'task_revision_conflict'); }
    return json({task:taskView(await getTask(env,id,auth.ownerId,material.taskVersion))},201);
  }
  const taskMatch = path.match(/^\/v1\/tasks\/([a-zA-Z0-9_-]+)(\/approve)?$/);
  if (taskMatch) {
    if (!taskMatch[2] && request.method === 'GET') return json({task:taskView(await getTask(env,taskMatch[1]!,auth.ownerId))});
    if (taskMatch[2] && request.method === 'POST') {
      const input = z.object({version:z.number().int().positive(),approvalHash:z.string()}).strict().parse(await body(request));
      const task = await getTask(env,taskMatch[1]!,auth.ownerId);
      requireCondition(task.version === input.version && task.approval_hash === input.approvalHash,409,'stale_approval');
      const updated = await env.DB.prepare('UPDATE tasks SET approved_at=COALESCE(approved_at,?) WHERE id=? AND version=? AND approval_hash=? AND NOT EXISTS(SELECT 1 FROM tasks newer WHERE newer.id=tasks.id AND newer.version>tasks.version)').bind(Date.now(),task.id,input.version,input.approvalHash).run();
      requireCondition(updated.meta.changes === 1,409,'stale_approval');
      return json({task:taskView(await getTask(env,task.id,auth.ownerId))});
    }
  }
  if (path === '/v1/runs' && request.method === 'POST') {
    const input = z.object({taskId:idSchema,taskVersion:z.number().int().positive(),approvalHash:z.string(),criteriaHash:z.string(),idempotencyKey:z.string().min(8).max(200)}).strict().parse(await body(request));
    const task = await getTask(env,input.taskId,auth.ownerId);
    const prior = await env.DB.prepare('SELECT * FROM runs WHERE task_id=? AND idempotency_key=?').bind(input.taskId,input.idempotencyKey).first<Row>();
    if (prior) {
      requireCondition(prior.task_version === input.taskVersion && prior.approval_hash === input.approvalHash && prior.criteria_hash === input.criteriaHash,409,'idempotency_conflict');
      const saved = await getRun(env,prior.id,auth.ownerId);
      return json({runId:saved.id,executionState:saved.execution_state,created:false,run:runView(saved)});
    }
    requireCondition(task.version === input.taskVersion && task.approved_at && task.approval_hash === input.approvalHash && task.criteria_hash === input.criteriaHash,409,'stale_approval');
    const approvedMaterial=JSON.parse(task.material_json);
    const lifetime=await usage(env,undefined,auth.ownerId);
    requireCondition(Number(lifetime.costUsd)+Number(approvedMaterial.limits.maxUsd)<=POC_BUDGET_USD+1e-9,409,'poc_budget_limit');
    const id = crypto.randomUUID(), now = Date.now();
    // Keep an active run readable for the full 30-minute Actions job timeout.
    // Terminal completion replaces this lease with the exact run-end + retention window.
    const activeExpires = now + Math.max(retention(env), 31 * 60_000);
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO runs(id,project_id,owner_id,task_id,task_version,approval_hash,criteria_hash,idempotency_key,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND approved_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks newer WHERE newer.id=tasks.id AND newer.version>tasks.version))').bind(id,task.project_id,auth.ownerId,task.id,task.version,task.approval_hash,task.criteria_hash,input.idempotencyKey,now,activeExpires,task.id,task.version),
        env.DB.prepare('INSERT INTO attempts(run_id,attempt,state,created_at) VALUES(?,1,?,?)').bind(id,'queued',now),
        env.DB.prepare('INSERT INTO poc_usage_totals(owner_id,run_count,updated_at) VALUES(?,1,?) ON CONFLICT(owner_id) DO UPDATE SET run_count=run_count+1,updated_at=excluded.updated_at').bind(auth.ownerId,now),
        env.DB.prepare('UPDATE projects SET expires_at=MAX(expires_at,?) WHERE id=? AND EXISTS(SELECT 1 FROM runs WHERE id=?)').bind(activeExpires,task.project_id,id),
      ]);
    } catch {
      const existing = await env.DB.prepare('SELECT * FROM runs WHERE task_id=? AND idempotency_key=?').bind(task.id,input.idempotencyKey).first<Row>();
      if (existing) {
        requireCondition(existing.task_version === input.taskVersion && existing.approval_hash === input.approvalHash && existing.criteria_hash === input.criteriaHash,409,'idempotency_conflict');
        return json({runId:existing.id,executionState:existing.execution_state,created:false,run:runView(existing)});
      }
      throw new HttpError(409,'active_run_or_stale_approval');
    }
    return json({runId:id,executionState:'queued',created:true,run:runView(await getRun(env,id,auth.ownerId))},201);
  }
  if (path === '/v1/usage' && request.method === 'GET') {
    const totals=await usage(env,undefined,auth.ownerId);
    const retained=(await env.DB.prepare("SELECT r.* FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.owner_id=? AND r.expires_at>? AND p.expires_at>? AND p.deleted_at IS NULL ORDER BY r.created_at DESC").bind(auth.ownerId,Date.now(),Date.now()).all<Row>()).results;
    const runs=await Promise.all(retained.map(async run=>({...runView(run),usage:await usage(env,run.id)})));
    const budget={capUsd:POC_BUDGET_USD,measuredUsedUsd:totals.costUsd,measuredRemainingUsd:totals.pocBudgetRemainingUsd,admissionEnforced:true,hardDollarCapVerified:false,method:'measured_usage_plus_approved_run_reservation',note:'New runs are admitted only when measured PoC usage plus the approved maxUsd reservation stays within $10. Provider cost is reported after model events, so an in-flight call may overshoot the total.'};
    return json({usage:totals,totals,runs,budget,hardDollarCapVerified:false});
  }
  if (path === '/v1/exports' && request.method === 'POST') return createExport(env,await project(env,idSchema.parse((await body(request)).projectId),auth.ownerId));
  const exportMatch = path.match(/^\/v1\/exports\/([a-zA-Z0-9_-]+)$/);
  if (exportMatch && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM exports WHERE id=?').bind(exportMatch[1]).first<Row>();
    requireCondition(row,404,'export_not_found'); await project(env,row.project_id,auth.ownerId);
    requireCondition(row.expires_at > Date.now(),410,'export_expired');
    return objectResponse(env,row.r2_key,row.sha256,row.byte_size,'application/zip',{'content-disposition':`attachment; filename="${row.id}.hardwire.zip"`});
  }
  if (path === '/v1/imports' && request.method === 'POST') return importArchive(env,auth.ownerId,await boundedBytes(request,MAX_ARCHIVE));
  throw new HttpError(404,'route_not_found');
}

async function projectView(env: Env, p: Row): Promise<Row> {
  const history = await env.DB.prepare('SELECT manifest_json FROM import_history WHERE project_id=?').bind(p.id).first<Row>();
  const runs = (await env.DB.prepare('SELECT * FROM runs WHERE project_id=? AND expires_at>? ORDER BY created_at DESC').bind(p.id,Date.now()).all<Row>()).results.map(runView);
  const tasks = (await env.DB.prepare('SELECT t.*,p.source_json FROM tasks t JOIN projects p ON p.id=t.project_id WHERE project_id=? ORDER BY t.created_at,t.version').bind(p.id).all<Row>()).results.map(taskView);
  return {id:p.id,projectId:p.id,ownerId:p.owner_id,name:p.name,source:JSON.parse(p.source_json),createdAt:iso(p.created_at),expiresAt:iso(p.expires_at),tasks,runs,latestRun:runs[0]??null,importedHistory:history?JSON.parse(history.manifest_json):null};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await fetchHandler(request,env); }
    catch (error) {
      if (error instanceof HttpError) return json({code:error.code},error.status);
      if (error instanceof z.ZodError) return json({code:'invalid_request',issues:error.issues.map(issue => ({path:issue.path,message:issue.message}))},400);
      // Database and provider errors may contain credentials or content. Emit only a stable code.
      return json({code:'service_unavailable'},503);
    }
  },
  async scheduled(_event: unknown, env: Env, context: {waitUntil(promise:Promise<unknown>):void}): Promise<void> {
    context.waitUntil(cleanup(env));
  },
};

async function importArchive(env: Env, owner: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const {manifest,files} = await validateArchive(bytes);
  // Retain immutable history separately: importing never resumes an untrusted archived active job.
  for (const task of manifest.tasks) {
    const material = approvalMaterialSchema.parse({taskId:task.taskId,taskVersion:task.version,objective:task.objective,allowedPaths:task.allowedPaths,limits:task.limits,criteria:task.criteria});
    requireCondition(await hashApprovalMaterial(material) === task.approvalHash,422,'archive_approval_hash_mismatch');
  }
  const taskKeys = new Set(manifest.tasks.map((task:Row) => `${task.taskId}:${task.version}`));
  requireCondition(taskKeys.size === manifest.tasks.length && new Set(manifest.runs.map((run:Row) => run.runId)).size === manifest.runs.length,400,'archive_duplicate_history');
  for (const run of manifest.runs) {
    requireCondition(taskKeys.has(`${run.taskId}:${run.taskVersion}`),400,'archive_unknown_task');
    const task = manifest.tasks.find((item:Row) => item.taskId === run.taskId && item.version === run.taskVersion);
    const criteriaHash = await hashValue(task.criteria);
    for (const artifact of run.artifacts) {
      requireCondition(artifact.runId === run.runId && artifact.criteriaHash === criteriaHash,422,'archive_evidence_identity_mismatch');
      if (artifact.kind === 'screenshot') await validatePng(files.get(artifact.path)!);
    }
  }
  for (const [path,content] of files) {
    safePath(path);
    // Credentials and tool caches never become project source, even if listed in a valid manifest.
    if (/\.(?:json|txt|log|md|ini|toml|ya?ml|[ch](?:pp)?|js|ts|py)$/i.test(path)) cleanPayload(new TextDecoder().decode(content));
  }
  const id = crypto.randomUUID(), now = Date.now(), expires = now + retention(env);
  const statements: Statement[] = [
    env.DB.prepare('INSERT INTO projects(id,owner_id,name,source_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,owner,manifest.project.name,JSON.stringify({kind:'hardwire-import',commit:manifest.project.sourceCommit}),now,expires),
    env.DB.prepare('INSERT INTO import_history(project_id,manifest_json) VALUES(?,?)').bind(id,JSON.stringify(manifest)),
  ];
  const written: string[] = [];
  try {
    const archiveKey = `projects/${id}/source.hardwire.zip`;
    await env.ARTIFACTS.put(archiveKey,bytes); written.push(archiveKey);
    statements.push(env.DB.prepare('INSERT INTO project_files(project_id,path,r2_key,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?)').bind(id,'__source_archive',archiveKey,await sha256(bytes),bytes.length,'application/zip'));
    for (const entry of manifest.files) {
      const key = `projects/${id}/files/${entry.path}`;
      await env.ARTIFACTS.put(key,files.get(entry.path)!); written.push(key);
      statements.push(env.DB.prepare('INSERT INTO project_files(project_id,path,r2_key,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?)').bind(id,entry.path,key,entry.sha256,entry.byteSize,entry.mediaType));
    }
    await env.DB.batch(statements);
  } catch (error) {
    // Prefix is new and private. Best-effort rollback cannot touch another project's objects.
    try { await env.ARTIFACTS.delete(written); } catch { /* Recorded below without secret error text. */ }
    await env.DB.prepare('INSERT INTO cleanup_events(id,project_id,attempted_at,result,error_code,retry_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,now,'import_failed','import_rollback_required',now+60000).run();
    throw error;
  }
  return json({project:{id,ownerId:owner,name:manifest.project.name,source:{kind:'hardwire-import',commit:manifest.project.sourceCommit},expiresAt:iso(expires)},importedHistory:{tasks:manifest.tasks.length,runs:manifest.runs.length,files:manifest.files.length}},201);
}

async function createExport(env: Env, p: Row): Promise<Response> {
  const files = new Map<string,Uint8Array<ArrayBuffer>>();
  const entries: Row[] = [];
  const history = await env.DB.prepare('SELECT manifest_json FROM import_history WHERE project_id=?').bind(p.id).first<Row>();
  const imported = history ? JSON.parse(history.manifest_json) : {tasks:[],runs:[]};
  for (const stored of (await env.DB.prepare("SELECT * FROM project_files WHERE project_id=? AND path<>'__source_archive'").bind(p.id).all<Row>()).results) {
    const object = await env.ARTIFACTS.get(stored.r2_key);
    requireCondition(object,422,'export_object_missing');
    const bytes = new Uint8Array(await object.arrayBuffer());
    requireCondition(bytes.length === stored.byte_size && await sha256(bytes) === stored.sha256,422,'export_checksum_mismatch');
    files.set(stored.path,bytes); entries.push({path:stored.path,byteSize:bytes.length,sha256:stored.sha256,mediaType:stored.media_type});
  }
  const tasks = [...imported.tasks];
  for (const row of (await env.DB.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,version').bind(p.id).all<Row>()).results) {
    const material = JSON.parse(row.material_json);
    tasks.push({taskId:row.id,version:row.version,objective:material.objective,allowedPaths:material.allowedPaths,limits:material.limits,approvalHash:row.approval_hash,approvedAt:iso(row.approved_at),criteria:material.criteria});
  }
  const runs = [...imported.runs];
  const liveRuns=(await env.DB.prepare('SELECT * FROM runs WHERE project_id=? AND expires_at>? ORDER BY created_at').bind(p.id,Date.now()).all<Row>()).results;
  for (const run of liveRuns) {
    const artifacts: Row[] = [];
    for (const artifact of (await env.DB.prepare('SELECT * FROM artifacts WHERE run_id=? AND verified=1 AND expires_at>? ORDER BY created_at').bind(run.id,Date.now()).all<Row>()).results) {
      const metadata = JSON.parse(artifact.metadata_json);
      const object = await env.ARTIFACTS.get(artifact.r2_key);
      requireCondition(object,422,'export_object_missing');
      const bytes = new Uint8Array(await object.arrayBuffer());
      requireCondition(bytes.length === artifact.byte_size && await sha256(bytes) === artifact.sha256,422,'export_checksum_mismatch');
      const path = `runs/${run.id}/artifacts/${artifact.id}`;
      requireCondition(!files.has(path),409,'export_path_collision');
      files.set(path,bytes); entries.push({path,byteSize:bytes.length,sha256:artifact.sha256,mediaType:metadata.mediaType});
      const {r2Key: _key,artifactId:_id,...identity} = metadata;
      artifacts.push({...identity,path});
    }
    const checkpoint = await env.DB.prepare("SELECT * FROM artifacts WHERE run_id=? AND kind='checkpoint' AND verified=1 AND checkpoint_sequence IS NOT NULL AND expires_at>? ORDER BY checkpoint_sequence DESC LIMIT 1").bind(run.id,Date.now()).first<Row>();
    if(checkpoint) {
      const object=await env.ARTIFACTS.get(checkpoint.r2_key);requireCondition(object,422,'export_object_missing');
      const bytes=new Uint8Array(await object.arrayBuffer());requireCondition(await sha256(bytes)===checkpoint.sha256,422,'export_checksum_mismatch');
      const source=await checkpointFiles(bytes,run,JSON.parse(checkpoint.metadata_json));
      for(const [relative,content] of source) {
        const path=`source/${relative}`;files.set(path,content);
        const entry={path,byteSize:content.length,sha256:await sha256(content),mediaType:'application/octet-stream'};
        const index=entries.findIndex(item=>item.path===path);if(index<0) entries.push(entry);else entries[index]=entry;
      }
    }
    const u = await usage(env,run.id);
    const attempts = (await env.DB.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY attempt').bind(run.id).all<Row>()).results.map(attempt => {
      const evidence = artifacts.find((a:Row) => a.attempt === attempt.attempt);
      return {attempt:attempt.attempt,sourceHash:attempt.source_hash ?? evidence?.sourceHash ?? '0'.repeat(64),firmwareHash:attempt.firmware_hash ?? evidence?.firmwareHash ?? null,scenarioHash:attempt.scenario_hash ?? evidence?.scenarioHash ?? null,executionState:attempt.state,startedAt:iso(attempt.created_at),finishedAt:iso(run.ended_at)};
    });
    const testResults = (await env.DB.prepare('SELECT result_json FROM test_results WHERE run_id=? ORDER BY attempt,criterion_id').bind(run.id).all<Row>()).results.map(row => JSON.parse(row.result_json));
    runs.push({runId:run.id,taskId:run.task_id,taskVersion:run.task_version,executionState:run.execution_state,acceptanceOutcome:run.acceptance_outcome,startedAt:iso(run.created_at),finishedAt:iso(run.ended_at),attempts,testResults,
      usage:{inputTokens:u.inputTokens,outputTokens:u.outputTokens,estimatedCostUsd:u.estimatedCostUsd,reportedCostUsd:u.reportedCostUsd,wokwiSeconds:u.wokwiSeconds,githubActionsSeconds:u.githubActionsSeconds,artifactBytes:u.artifactBytes},artifacts});
  }
  if(![...files.keys()].some(path=>path.startsWith('source/'))) {
    const source=JSON.parse(p.source_json);
    requireCondition(source.kind==='gunny-snapshot'&&source.commit===SNAPSHOT_COMMIT,422,'source_not_materialized');
    const baseline=await fetchSnapshot();
    const rows:Statement[]=[];
    for(const [relative,content] of baseline) {
      const path=`source/${relative}`,digest=await sha256(content),key=`projects/${p.id}/baseline/${relative}`;
      await env.ARTIFACTS.put(key,content);
      rows.push(env.DB.prepare('INSERT OR IGNORE INTO project_files(project_id,path,r2_key,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?)').bind(p.id,path,key,digest,content.length,'application/octet-stream'));
      files.set(path,content);entries.push({path,byteSize:content.length,sha256:digest,mediaType:'application/octet-stream'});
    }
    await env.DB.batch(rows);
  }
  const manifest = archiveManifestSchema.parse({format:'hardwire-archive',formatVersion:1,createdAt:iso(Date.now()),project:{name:p.name,sourceCommit:JSON.parse(p.source_json).commit ?? null},tasks,runs,files:entries});
  files.set('manifest.json',encoder.encode(JSON.stringify(manifest)));
  const bytes = writeZip(files);
  // Validate generated archives through the same import boundary before storing any export.
  await validateArchive(bytes);
  const id = crypto.randomUUID(), key = `projects/${p.id}/exports/${id}.hardwire.zip`, digest = await sha256(bytes);
  const exportExpires=Math.min(p.expires_at,...liveRuns.map(run=>run.expires_at));
  await env.ARTIFACTS.put(key,bytes);
  const sourceArchive=await env.DB.prepare("SELECT path FROM project_files WHERE project_id=? AND path='__source_archive'").bind(p.id).first<Row>();
  const statements=[env.DB.prepare('INSERT INTO exports(id,project_id,r2_key,manifest_json,sha256,byte_size,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,p.id,key,JSON.stringify(manifest),digest,bytes.length,Date.now(),exportExpires)];
  if(!sourceArchive) {
    const sourceFiles=new Map([...files].filter(([path])=>path.startsWith('source/')));
    const sourceManifest=archiveManifestSchema.parse({...manifest,tasks:[],runs:[],files:manifest.files.filter(file=>file.path.startsWith('source/'))});
    sourceFiles.set('manifest.json',encoder.encode(JSON.stringify(sourceManifest)));
    const sourceBytes=writeZip(sourceFiles),sourceKey=`projects/${p.id}/source/${id}.hardwire.zip`;
    await env.ARTIFACTS.put(sourceKey,sourceBytes);
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO project_files(project_id,path,r2_key,sha256,byte_size,media_type) VALUES(?,?,?,?,?,?)').bind(p.id,'__source_archive',sourceKey,await sha256(sourceBytes),sourceBytes.length,'application/zip'));
  }
  await env.DB.batch(statements);
  return json({export:{id,projectId:p.id,sha256:digest,byteSize:bytes.length,expiresAt:iso(exportExpires),downloadPath:`/v1/exports/${id}`}},201);
}

export async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM runner_sessions WHERE expires_at<=?').bind(now).run();
  const expiredRuns=(await env.DB.prepare('SELECT r.* FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.expires_at<=? AND r.next_cleanup_at<=? AND p.expires_at>? AND p.deleted_at IS NULL LIMIT 25').bind(now,now,now).all<Row>()).results;
  for(const run of expiredRuns) {
    try {
      let cursor:string|undefined;
      do {
        const listed=await env.ARTIFACTS.list({prefix:`projects/${run.project_id}/runs/${run.id}/`,cursor,limit:500});
        if(listed.objects.length) await env.ARTIFACTS.delete(listed.objects.map(object=>object.key));
        cursor=listed.truncated?listed.cursor:undefined;requireCondition(!listed.truncated||cursor,503,'cleanup_cursor_missing');
      } while(cursor);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM runner_sessions WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM workflow_bindings WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM resume_requests WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM usage WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM test_results WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM artifacts WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM events WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM attempts WHERE run_id=?').bind(run.id),
        env.DB.prepare('DELETE FROM runs WHERE id=?').bind(run.id),
        env.DB.prepare('INSERT INTO cleanup_events(id,project_id,run_id,attempted_at,result,deletion_lag_seconds) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),run.project_id,run.id,now,'run_deleted',Math.max(0,(now-run.expires_at)/1000)),
      ]);
    } catch {
      const retryAt=now+Math.min(3600000,60000*2**Math.min(run.cleanup_attempts,6));
      await env.DB.batch([
        env.DB.prepare("UPDATE runs SET cleanup_attempts=cleanup_attempts+1,cleanup_error='run_cleanup_failed',next_cleanup_at=? WHERE id=?").bind(retryAt,run.id),
        env.DB.prepare('INSERT INTO cleanup_events(id,project_id,run_id,attempted_at,result,error_code,retry_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),run.project_id,run.id,now,'run_retry','run_cleanup_failed',retryAt),
      ]);
    }
  }
  const expiredExports=(await env.DB.prepare('SELECT e.* FROM exports e JOIN projects p ON p.id=e.project_id WHERE e.expires_at<=? AND e.next_cleanup_at<=? AND p.expires_at>? AND p.deleted_at IS NULL LIMIT 25').bind(now,now,now).all<Row>()).results;
  for(const item of expiredExports) {
    try {
      await env.ARTIFACTS.delete(item.r2_key);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM exports WHERE id=?').bind(item.id),
        env.DB.prepare('INSERT INTO cleanup_events(id,project_id,export_id,attempted_at,result,deletion_lag_seconds) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),item.project_id,item.id,now,'export_deleted',Math.max(0,(now-item.expires_at)/1000)),
      ]);
    } catch {
      const retryAt=now+Math.min(3600000,60000*2**Math.min(item.cleanup_attempts,6));
      await env.DB.batch([
        env.DB.prepare("UPDATE exports SET cleanup_attempts=cleanup_attempts+1,cleanup_error='export_cleanup_failed',next_cleanup_at=? WHERE id=?").bind(retryAt,item.id),
        env.DB.prepare('INSERT INTO cleanup_events(id,project_id,export_id,attempted_at,result,error_code,retry_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),item.project_id,item.id,now,'export_retry','export_cleanup_failed',retryAt),
      ]);
    }
  }
  const projects = (await env.DB.prepare('SELECT * FROM projects WHERE expires_at<=? AND deleted_at IS NULL AND next_cleanup_at<=? LIMIT 25').bind(now,now).all<Row>()).results;
  for (const p of projects) {
    try {
      // Walk the complete private project prefix, including objects stranded by failed metadata writes.
      let cursor: string | undefined;
      do {
        const listed = await env.ARTIFACTS.list({prefix:`projects/${p.id}/`,cursor,limit:500});
        if (listed.objects.length) await env.ARTIFACTS.delete(listed.objects.map(object => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
        requireCondition(!listed.truncated || cursor,503,'cleanup_cursor_missing');
      } while (cursor);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM runner_sessions WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM workflow_bindings WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM resume_requests WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM usage WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM test_results WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM artifacts WHERE project_id=?').bind(p.id),
        env.DB.prepare('DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM attempts WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM runs WHERE project_id=?').bind(p.id),
        env.DB.prepare('DELETE FROM criteria WHERE (task_id,task_version) IN (SELECT id,version FROM tasks WHERE project_id=?)').bind(p.id),
        env.DB.prepare('DELETE FROM tasks WHERE project_id=?').bind(p.id),
        env.DB.prepare('DELETE FROM exports WHERE project_id=?').bind(p.id),
        env.DB.prepare('DELETE FROM project_files WHERE project_id=?').bind(p.id),
        env.DB.prepare('DELETE FROM import_history WHERE project_id=?').bind(p.id),
        env.DB.prepare("UPDATE projects SET source_json='{}',name='[expired]',deleted_at=?,cleanup_state='deleted',cleanup_attempts=cleanup_attempts+1,cleanup_error=NULL WHERE id=?").bind(now,p.id),
        env.DB.prepare('INSERT INTO cleanup_events(id,project_id,attempted_at,result,deletion_lag_seconds) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),p.id,now,'deleted',Math.max(0,(now-p.expires_at)/1000)),
      ]);
    } catch {
      const retryAt = now + Math.min(3600000,60000 * 2 ** Math.min(p.cleanup_attempts,6));
      await env.DB.batch([
        env.DB.prepare("UPDATE projects SET cleanup_state='retry',cleanup_attempts=cleanup_attempts+1,cleanup_error='cleanup_failed',next_cleanup_at=? WHERE id=?").bind(retryAt,p.id),
        env.DB.prepare('INSERT INTO cleanup_events(id,project_id,attempted_at,result,error_code,retry_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),p.id,now,'retry','cleanup_failed',retryAt),
      ]);
    }
  }
  // Retry orphan prefixes from failed imports even when no project row was committed.
  const orphans = (await env.DB.prepare("SELECT DISTINCT project_id FROM cleanup_events WHERE result='import_failed' AND retry_at<=? AND project_id NOT IN (SELECT id FROM projects) LIMIT 10").bind(now).all<Row>()).results;
  for (const orphan of orphans) {
    try {
      const listed = await env.ARTIFACTS.list({prefix:`projects/${orphan.project_id}/`,limit:500});
      if (listed.objects.length) await env.ARTIFACTS.delete(listed.objects.map(object=>object.key));
      await env.DB.prepare('UPDATE cleanup_events SET result=?,retry_at=? WHERE project_id=? AND result=?').bind(listed.truncated?'import_failed':'orphan_deleted',listed.truncated?now+60000:null,orphan.project_id,'import_failed').run();
    } catch {
      await env.DB.prepare("UPDATE cleanup_events SET retry_at=?,error_code='orphan_cleanup_failed' WHERE project_id=? AND result='import_failed'").bind(now+60000,orphan.project_id).run();
    }
  }
}
