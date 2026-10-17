import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync,gzipSync } from 'node:zlib';
import { fixture,setup } from './fixtures.ts';
import { cleanup } from '../src/index.ts';
import { crc32,validateArchive,validatePng,writeZip } from '../src/archive.ts';
import { sha256 } from '../src/types.ts';
import { validateOidc } from '../src/auth.ts';
import { SNAPSHOT_COMMIT } from '../src/snapshot.ts';

const encoder=new TextEncoder();
function event(runId:string,sequence:number,type='heartbeat',payload:Record<string,unknown>={}) { return {eventId:`event-${sequence}`,runId,sequence,occurredAt:new Date().toISOString(),type,payload}; }

test('service auth is required and founder header is trusted only with service secret',async()=>{
  const f=fixture();
  assert.equal((await f.request('/v1/projects','GET',undefined,'wrong')).status,401);
  assert.equal((await f.request('/v1/projects','GET',undefined,undefined,{'x-founder-id':'other'})).status,401);
});

test('OIDC validates cryptographic signature, exact workflow/run claims, expiration and one-time exchange',async(t)=>{
  const f=await setup();
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:Uint8Array.of(1,0,1),hash:'SHA-256'},true,['sign','verify']);
  const kid=crypto.randomUUID(),jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid};
  const fetcher=(async(input:RequestInfo|URL)=>{assert.equal(String(input),'https://token.actions.githubusercontent.com/.well-known/jwks');return Response.json({keys:[jwk]});}) as typeof fetch;
  t.mock.method(globalThis,'fetch',fetcher);
  const now=Math.floor(Date.now()/1000);
  const claims={iss:'https://token.actions.githubusercontent.com',aud:f.env.OIDC_AUDIENCE,exp:now+300,nbf:now-1,iat:now,jti:crypto.randomUUID(),repository:f.env.GITHUB_REPOSITORY,workflow_ref:f.env.GITHUB_WORKFLOW_REF,event_name:'workflow_dispatch',run_id:'1234',run_attempt:'1',sub:'repo:example/hardwire:ref:refs/heads/main'};
  const base64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64url');
  async function sign(changes:Record<string,unknown>={}) {
    const input=base64(encoder.encode(JSON.stringify({alg:'RS256',kid})))+'.'+base64(encoder.encode(JSON.stringify({...claims,...changes})));
    return input+'.'+base64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,encoder.encode(input))));
  }
  const run={...f.run,workflow_run_id:'1234'};
  assert.equal((await validateOidc(await sign(),f.env,run,fetcher)).run_id,'1234');
  for(const changes of [{aud:'wrong'},{repository:'attacker/fork'},{workflow_ref:'wrong'},{run_id:'9999'},{run_attempt:'2'},{exp:now-1}]) await assert.rejects(validateOidc(await sign(changes),f.env,run,fetcher));
  const token=await sign();const parts=token.split('.');
  const forged=parts[0]+'.'+base64(encoder.encode(JSON.stringify({...claims,run_id:'9999'})))+'.'+parts[2];
  await assert.rejects(validateOidc(forged,f.env,run,fetcher));
  await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',{workflowRunId:'1234',workflowUrl:'https://github.com/example/hardwire/actions/runs/1234'});
  const exchange=await f.request('/v1/runner/exchange','POST',{runId:f.run.id},token);
  assert.equal(exchange.status,200);const result=await exchange.json() as any;
  assert.equal(result.run.approvalHash,f.run.approvalHash);assert.ok(result.token);assert.ok(result.run.approvalMaterial);
  assert.equal((await f.request(`/v1/runs/${f.run.id}`,'GET',undefined,result.token)).status,200);
  assert.equal((await f.request('/v1/runner/exchange','POST',{runId:f.run.id},token)).status,409);
  const row=await f.DB.prepare('SELECT token_hash FROM runner_sessions WHERE oidc_jti=?').bind(claims.jti).first<any>();
  assert.notEqual(row.token_hash,result.token);assert.equal(row.token_hash,await sha256(encoder.encode(result.token)));
});

test('approved revisions, durable idempotency, active-run uniqueness and workflow attachment',async()=>{
  const f=await setup();
  const repeat=await(await f.request('/v1/runs','POST',f.start)).json() as any;
  assert.equal(repeat.created,false); assert.equal(repeat.runId,f.run.id);
  assert.equal((await f.request('/v1/runs','POST',{...f.start,idempotencyKey:'another-key'})).status,409);
  assert.equal((await f.request('/v1/runs','POST',{...f.start,approvalHash:'b'.repeat(64)})).status,409);
  const workflow={workflowRunId:'1234',workflowUrl:'https://github.com/example/hardwire/actions/runs/1234'};
  assert.equal((await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',workflow)).status,200);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',workflow)).status,200);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',{workflowRunId:'5678',workflowUrl:'https://github.com/example/hardwire/actions/runs/5678'})).status,409);
  const snapshot=await(await f.request(`/v1/runs/${f.run.id}`)).json() as any;
  assert.equal(snapshot.run.workflowRunId,'1234'); assert.equal(snapshot.run.acceptanceOutcome,null);
});

test('starting a run leases project and run data through the workflow deadline',async()=>{
  const f=fixture();f.env.RETENTION_SECONDS='60';
  const project=await(await f.request('/v1/projects','POST',{name:'Near expiry',source:{kind:'gunny-snapshot',commit:SNAPSHOT_COMMIT}})).json() as any;
  const task=await(await f.request('/v1/tasks','POST',{projectId:project.project.id,version:1,objective:'Test expiry lease',allowedPaths:['src/main.cpp'],limits:{timeoutSeconds:60,maxRepairRounds:3,maxUsd:1},criteria:[{id:'serial',required:true,text:'Serial expected',evidence:['serial_log']}]})).json() as any;
  await f.request(`/v1/tasks/${task.task.id}/approve`,'POST',{version:1,approvalHash:task.task.approvalHash});
  await f.DB.prepare('UPDATE projects SET expires_at=? WHERE id=?').bind(Date.now()+1000,project.project.id).run();
  const started=await(await f.request('/v1/runs','POST',{taskId:task.task.id,taskVersion:1,approvalHash:task.task.approvalHash,criteriaHash:task.task.criteriaHash,idempotencyKey:'active-lease-0001'})).json() as any;
  const run=await f.DB.prepare('SELECT expires_at FROM runs WHERE id=?').bind(started.runId).first<any>();
  const savedProject=await f.DB.prepare('SELECT expires_at FROM projects WHERE id=?').bind(project.project.id).first<any>();
  assert.ok(run.expires_at>Date.now()+30*60*1000);
  assert.equal(savedProject.expires_at,run.expires_at);
});

test('task revisions remain immutable and latest revision requires fresh approval',async()=>{
  const f=await setup();
  const material={taskId:f.task.id,projectId:f.project.id,version:2,objective:'changed',allowedPaths:f.task.allowedPaths,limits:f.task.limits,criteria:f.task.criteria};
  assert.equal((await f.request('/v1/tasks','POST',material)).status,201);
  assert.equal((await f.request('/v1/tasks','POST',material)).status,409);
  assert.equal((await f.request(`/v1/tasks/${f.task.id}/approve`,'POST',{version:1,approvalHash:f.task.approvalHash})).status,409);
  const latest=await(await f.request(`/v1/tasks/${f.task.id}`)).json() as any;
  assert.equal(latest.task.version,2); assert.equal(latest.task.approvedAt,null);
});

test('runner tokens are run-scoped, expiring and cannot call API write routes',async()=>{
  const f=await setup();
  assert.equal((await f.request(`/v1/runs/${f.run.id}`,'GET',undefined,f.token)).status,200);
  assert.equal((await f.request('/v1/runs/other','GET',undefined,f.token)).status,401);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/cancel`,'POST',{},f.token)).status,403);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,1))).status,403);
  await f.DB.prepare('UPDATE runner_sessions SET expires_at=?').bind(Date.now()-1).run();
  assert.equal((await f.request(`/v1/runs/${f.run.id}`,'GET',undefined,f.token)).status,401);
});

test('events enforce ordered sequence, exact duplicate replay, content conflicts and usage once',async()=>{
  const f=await setup();
  const initial=await(await f.request(`/v1/runs/${f.run.id}`)).json() as any;
  assert.equal(initial.usage.providerUsageMeasured,false);assert.equal(initial.usage.reportedCostUsd,0);
  assert.equal(initial.attempts.length,1);assert.equal(initial.attempts[0].attempt,1);assert.equal(initial.attempts[0].executionState,'queued');
  const usage=event(f.run.id,1,'usage',{inputTokens:12,outputTokens:3,costUsd:0.02});
  assert.equal((await f.request(`/v1/runs/${f.run.id}/events`,'POST',usage,f.token)).status,200);
  const duplicate=await(await f.request(`/v1/runs/${f.run.id}/events`,'POST',usage,f.token)).json() as any;
  assert.equal(duplicate.duplicate,true);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/events`,'POST',{...usage,payload:{inputTokens:99}},f.token)).status,409);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/events`,'POST',{...usage,eventId:'other'},f.token)).status,409);
  const snapshot=await(await f.request(`/v1/runs/${f.run.id}`)).json() as any;
  assert.equal(snapshot.usage.inputTokens,12); assert.equal(snapshot.usage.costUsd,0.02);
  assert.equal(snapshot.usage.providerUsageMeasured,true);assert.equal(snapshot.usage.reportedCostUsd,0.02);
});

test('PoC usage total survives run cleanup and reserves approved maxUsd before a new run',async()=>{
  const f=await setup();f.env.RETENTION_SECONDS='1';
  await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,1,'usage',{inputTokens:900,outputTokens:100,costUsd:9.25,steps:1}),f.token);
  await f.request(`/v1/runs/${f.run.id}/finish`,'POST',{executionState:'completed',acceptanceOutcome:'inconclusive',summary:'budget fixture'},f.token);
  const rejected=await f.request('/v1/runs','POST',{...f.start,idempotencyKey:'budget-reservation-0001'});
  assert.equal(rejected.status,409);assert.equal((await rejected.json() as any).code,'poc_budget_limit');
  const usage=await(await f.request('/v1/usage')).json() as any;
  assert.equal(usage.usage.scope,'poc_lifetime');assert.equal(usage.usage.runCount,1);
  assert.equal(usage.usage.costUsd,9.25);assert.equal(usage.usage.pocBudgetRemainingUsd,0.75);
  assert.equal(usage.budget.admissionEnforced,true);assert.equal(usage.runs.length,1);
  await f.DB.prepare('UPDATE runs SET expires_at=? WHERE id=?').bind(Date.now()-1000,f.run.id).run();
  await f.DB.prepare('UPDATE projects SET expires_at=? WHERE id=?').bind(Date.now()+60_000,f.project.id).run();
  await cleanup(f.env);
  const after=await(await f.request('/v1/usage')).json() as any;
  assert.equal(after.runs.length,0);assert.equal(after.usage.runCount,1);assert.equal(after.usage.costUsd,9.25);
  assert.equal(after.usage.artifactBytes,0);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE id=?').bind(f.run.id).first<any>()).n,0);
});

test('artifact upload checks bytes, identity, private reads and criterion evaluator gate',async()=>{
  const f=await setup(); const bytes=encoder.encode('expected serial output');
  const meta={artifactId:'evidence-1',runId:f.run.id,attempt:1,testCaseId:'serial',sourceHash:'a'.repeat(64),firmwareHash:'b'.repeat(64),scenarioHash:'c'.repeat(64),criteriaHash:f.run.criteriaHash,kind:'serial_log',toolVersions:{wokwi:'0.28.1'},capturedAt:new Date().toISOString(),byteSize:bytes.length,sha256:await sha256(bytes),mediaType:'text/plain'};
  assert.equal((await f.request(`/v1/runs/${f.run.id}/artifacts`,'POST',bytes,f.token,{'x-artifact-metadata':JSON.stringify({...meta,sha256:'0'.repeat(64)})})).status,422);
  assert.equal(f.ARTIFACTS.objects.size,0);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/artifacts`,'POST',bytes,f.token,{'x-artifact-metadata':JSON.stringify(meta)})).status,201);
  assert.equal((await f.request(`/v1/artifacts/evidence-1`,'GET',undefined,'bad')).status,401);
  assert.equal(await(await f.request('/v1/artifacts/evidence-1')).text(),'expected serial output');
  assert.equal((await f.request(`/v1/runs/${f.run.id}/finish`,'POST',{executionState:'completed',acceptanceOutcome:'passed',summary:'done'},f.token)).status,422);
  const criterion={criterionId:'serial',outcome:'passed',explanation:'matched',evidenceIds:['evidence-1'],sourceHash:meta.sourceHash,firmwareHash:meta.firmwareHash,scenarioHash:meta.scenarioHash,criteriaHash:meta.criteriaHash};
  assert.equal((await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,1,'criterion',criterion),f.token)).status,200);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/finish`,'POST',{executionState:'completed',acceptanceOutcome:'passed',summary:'done'},f.token)).status,200);
  const snapshot=await(await f.request(`/v1/runs/${f.run.id}`)).json() as any;
  assert.equal(snapshot.run.executionState,'completed'); assert.equal(snapshot.run.acceptanceOutcome,'passed');
});

test('infrastructure blocker finishes inconclusive, cancels remain durable and retries are idempotent',async()=>{
  const f=await setup();
  await f.request(`/v1/runs/${f.run.id}/cancel`,'POST',{});
  const snapshot=await(await f.request(`/v1/runs/${f.run.id}`,'GET',undefined,f.token)).json() as any;
  assert.equal(snapshot.run.cancellationRequested,true);
  const finish={executionState:'failed',acceptanceOutcome:'inconclusive',summary:'missing_secret'};
  assert.equal((await f.request(`/v1/runs/${f.run.id}/finish`,'POST',finish,f.token)).status,200);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/finish`,'POST',finish,f.token)).status,200);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/finish`,'POST',{...finish,acceptanceOutcome:'passed'},f.token)).status,409);
});

test('expired access is denied before scheduled deletion; cleanup errors record retry without secret text',async()=>{
  const f=await setup();
  await f.ARTIFACTS.put(`projects/${f.project.id}/orphan`,encoder.encode('private'));
  await f.DB.prepare('UPDATE projects SET expires_at=? WHERE id=?').bind(Date.now()-1000,f.project.id).run();
  assert.equal((await f.request(`/v1/runs/${f.run.id}`)).status,410);
  f.ARTIFACTS.failDelete=true; await cleanup(f.env);
  const failure=await f.DB.prepare('SELECT cleanup_state,cleanup_attempts,cleanup_error FROM projects WHERE id=?').bind(f.project.id).first<any>();
  assert.equal(failure.cleanup_state,'retry');assert.equal(failure.cleanup_attempts,1);assert.equal(failure.cleanup_error,'cleanup_failed');
  f.ARTIFACTS.failDelete=false; await f.DB.prepare('UPDATE projects SET next_cleanup_at=0').run(); await cleanup(f.env);
  assert.equal(f.ARTIFACTS.objects.size,0);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM runs').first<any>()).n,0);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM cleanup_events WHERE result='deleted'").first<any>()).n,1);
});

test('private checkpoints and objects are checksum-verified again before serving',async()=>{
  const f=await setup(),source=encoder.encode('int main() {}');
  const sourceHash=await sha256(encoder.encode(JSON.stringify([['src/main.cpp',await sha256(source)]])));
  const bytes=encoder.encode(JSON.stringify({format:'hardwire-checkpoint',formatVersion:1,runId:f.run.id,approvalHash:f.run.approvalHash,criteriaHash:f.run.criteriaHash,attempt:1,sourceHash,files:{'src/main.cpp':Buffer.from(source).toString('base64')}}));
  const metadata={artifactId:'checkpoint-1',runId:f.run.id,attempt:1,testCaseId:'checkpoint',sourceHash,firmwareHash:'b'.repeat(64),scenarioHash:'c'.repeat(64),criteriaHash:f.run.criteriaHash,kind:'checkpoint',toolVersions:{runner:'1'},capturedAt:new Date().toISOString(),byteSize:bytes.length,sha256:await sha256(bytes),mediaType:'application/json'};
  assert.equal((await f.request(`/v1/runs/${f.run.id}/checkpoint`,'GET',undefined,f.token)).status,204);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/artifacts`,'POST',bytes,f.token,{'x-artifact-metadata':JSON.stringify(metadata)})).status,201);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/checkpoint`,'GET',undefined,f.token)).status,204);
  await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,1,'checkpoint',{artifactId:'checkpoint-1',sha256:metadata.sha256,sourceHash}),f.token);
  await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,2),f.token);
  const response=await f.request(`/v1/runs/${f.run.id}/checkpoint`,'GET',undefined,f.token);
  assert.equal(response.headers.get('x-artifact-sha256'),metadata.sha256);assert.equal(response.headers.get('x-checkpoint-sequence'),'1');assert.equal(await response.text(),new TextDecoder().decode(bytes));
  const exported=await(await f.request('/v1/exports','POST',{projectId:f.project.id})).json() as any;
  assert.ok(exported.export,JSON.stringify(exported));
  const archive=await validateArchive(new Uint8Array(await(await f.request(exported.export.downloadPath)).arrayBuffer()));
  assert.equal(new TextDecoder().decode(archive.files.get('source/src/main.cpp')),'int main() {}');
  const key=[...f.ARTIFACTS.objects.keys()][0]!;f.ARTIFACTS.objects.set(key,encoder.encode('wrong'));
  assert.equal((await f.request(`/v1/runs/${f.run.id}/checkpoint`,'GET',undefined,f.token)).status,422);
});

async function basicArchive() {
  const bytes=encoder.encode('int main() {}\n');
  const manifest={format:'hardwire-archive',formatVersion:1,createdAt:new Date().toISOString(),project:{name:'Imported',sourceCommit:'a'.repeat(40)},tasks:[],runs:[],files:[{path:'source/src/main.cpp',byteSize:bytes.length,sha256:await sha256(bytes),mediaType:'text/plain'}]};
  return writeZip(new Map([['manifest.json',encoder.encode(JSON.stringify(manifest))],['source/src/main.cpp',bytes]]));
}

test('archive import/export preserves source checksums and isolated read-only history',async()=>{
  const f=fixture();const bytes=await basicArchive();
  const imported=await(await f.request('/v1/imports','POST',bytes)).json() as any;
  assert.ok(imported.project?.id);
  const detail=await(await f.request(`/v1/projects/${imported.project.id}`)).json() as any;
  assert.equal(detail.project.importedHistory.files[0].path,'source/src/main.cpp');
  const exported=await(await f.request('/v1/exports','POST',{projectId:imported.project.id})).json() as any;
  const response=await f.request(exported.export.downloadPath);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');
  const validated=await validateArchive(new Uint8Array(await response.arrayBuffer()));
  assert.equal(new TextDecoder().decode(validated.files.get('source/src/main.cpp')),'int main() {}\n');
  const importedAgain=await(await f.request('/v1/imports','POST',bytes)).json() as any;
  assert.notEqual(importedAgain.project.id,imported.project.id);
});

test('ZIP traversal, symlinks, corrupted checksums and unlisted files are rejected before writes',async()=>{
  const f=fixture(),bytes=await basicArchive();
  const corrupt=bytes.slice();corrupt[50]^=1;
  assert.equal((await f.request('/v1/imports','POST',corrupt)).status,400);assert.equal(f.ARTIFACTS.objects.size,0);
  assert.throws(()=>writeZip(new Map([['../escape',encoder.encode('x')]])));
  const symlink=bytes.slice(),view=new DataView(symlink.buffer);let pos=-1;
  for(let i=0;i<symlink.length-46;i++) if(view.getUint32(i,true)===0x02014b50){pos=i;break;}
  view.setUint32(pos+38,0xa1ff0000,true);
  assert.equal((await f.request('/v1/imports','POST',symlink)).status,400);
});

function png():Uint8Array<ArrayBuffer> {
  const signature=Uint8Array.of(137,80,78,71,13,10,26,10);
  const ihdr=new Uint8Array(13),view=new DataView(ihdr.buffer);view.setUint32(0,1);view.setUint32(4,1);ihdr[8]=8;ihdr[9]=6;
  const chunks=[['IHDR',ihdr],['IDAT',new Uint8Array(deflateSync(Uint8Array.of(0,255,0,0,255)))],['IEND',new Uint8Array()]] as const;
  const bytes=new Uint8Array(8+chunks.reduce((sum,[,data])=>sum+data.length+12,0));bytes.set(signature);let offset=8;
  for(const [type,data] of chunks){const part=new DataView(bytes.buffer);part.setUint32(offset,data.length);bytes.set(encoder.encode(type),offset+4);bytes.set(data,offset+8);part.setUint32(offset+8+data.length,crc32(bytes.subarray(offset+4,offset+8+data.length)));offset+=12+data.length;}
  return bytes;
}

test('PNG evidence validates compressed pixels and CRC rather than only file extension',async()=>{
  await validatePng(png());
  await assert.rejects(validatePng(encoder.encode('not a PNG')));
  const corrupt=png();corrupt[corrupt.length-1]^=1;await assert.rejects(validatePng(corrupt));
});

function snapshotTar():Uint8Array<ArrayBuffer> {
  const pieces:Buffer[]=[];
  for(const [path,text] of [['src/main.cpp','int main() {}'],['platformio.ini','[env:esp32dev]'],['diagram.json','{}']]) {
    const content=Buffer.from(text!),header=Buffer.alloc(512);
    header.write(`buildthings-gunny-arcade-${SNAPSHOT_COMMIT}/${path}`,0);
    header.write(content.length.toString(8).padStart(11,'0')+'\0',124);
    header.fill(32,148,156);header.write('0',156);
    const sum=header.reduce((n,b)=>n+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
    pieces.push(header,content,Buffer.alloc((512-content.length%512)%512));
  }
  pieces.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(pieces)));
}

test('pre-run export materializes only the fixed pinned public baseline and imports usable source',async(t)=>{
  const f=fixture();let fetches=0;
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{fetches++;assert.equal(String(url),`https://codeload.github.com/withbuildthings/buildthings-gunny-arcade/tar.gz/${SNAPSHOT_COMMIT}`);return new Response(snapshotTar());});
  const p=await(await f.request('/v1/projects','POST',{name:'Baseline',source:{kind:'gunny-snapshot',commit:SNAPSHOT_COMMIT}})).json() as any;
  const exported=await(await f.request('/v1/exports','POST',{projectId:p.project.id})).json() as any;
  assert.ok(exported.export,JSON.stringify(exported));assert.equal(fetches,1);
  const bytes=new Uint8Array(await(await f.request(exported.export.downloadPath)).arrayBuffer());
  const archive=await validateArchive(bytes);assert.equal(archive.files.size,3);assert.ok(archive.files.has('source/platformio.ini'));
  const imported=await f.request('/v1/imports','POST',bytes);assert.equal(imported.status,201);
  await f.request('/v1/exports','POST',{projectId:p.project.id});assert.equal(fetches,1);
});

test('interrupted run resumes once with retained checkpoint, sequence, usage and dispatch history',async()=>{
  const f=await setup();
  const workflow={workflowRunId:'1234',workflowUrl:'https://github.com/example/hardwire/actions/runs/1234'};
  await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',workflow);
  const file=encoder.encode('source');const sourceHash=await sha256(encoder.encode(JSON.stringify([['src/main.cpp',await sha256(file)]])));
  const bytes=encoder.encode(JSON.stringify({format:'hardwire-checkpoint',formatVersion:1,runId:f.run.id,approvalHash:f.run.approvalHash,criteriaHash:f.run.criteriaHash,attempt:1,sourceHash,files:{'src/main.cpp':Buffer.from(file).toString('base64')}}));
  const metadata={artifactId:'resume-checkpoint',runId:f.run.id,attempt:1,testCaseId:'gunny-30s',sourceHash,firmwareHash:'b'.repeat(64),scenarioHash:'c'.repeat(64),criteriaHash:f.run.criteriaHash,kind:'checkpoint',toolVersions:{runner:'1'},capturedAt:new Date().toISOString(),byteSize:bytes.length,sha256:await sha256(bytes),mediaType:'application/json'};
  assert.equal((await f.request(`/v1/runs/${f.run.id}/artifacts`,'POST',bytes,f.token,{'x-artifact-metadata':JSON.stringify(metadata)})).status,201);
  await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,1,'checkpoint',{artifactId:metadata.artifactId,sha256:metadata.sha256,sourceHash}),f.token);
  await f.request(`/v1/runs/${f.run.id}/events`,'POST',event(f.run.id,2,'usage',{inputTokens:42,reasoningTokens:3,cacheReadTokens:4,costUsd:0.25,steps:2,calls:1}),f.token);
  await f.request(`/v1/runs/${f.run.id}/finish`,'POST',{executionState:'interrupted',acceptanceOutcome:'inconclusive',summary:'runner_lost'},f.token);
  const nearExpiry=Date.now()+60_000;
  await f.DB.prepare('UPDATE runs SET expires_at=? WHERE id=?').bind(nearExpiry,f.run.id).run();
  await f.DB.prepare('UPDATE projects SET expires_at=? WHERE id=?').bind(nearExpiry,f.project.id).run();
  await f.DB.prepare('UPDATE artifacts SET expires_at=? WHERE run_id=?').bind(nearExpiry,f.run.id).run();
  await f.DB.prepare('UPDATE events SET expires_at=? WHERE run_id=?').bind(nearExpiry,f.run.id).run();
  const prior=await f.DB.prepare('SELECT expires_at FROM runs WHERE id=?').bind(f.run.id).first<any>();
  const simultaneous=await Promise.all([f.request(`/v1/runs/${f.run.id}/resume`,'POST',{idempotencyKey:'resume-key-001'}),f.request(`/v1/runs/${f.run.id}/resume`,'POST',{idempotencyKey:'resume-key-001'})]);
  const resumeResults=await Promise.all(simultaneous.map(response=>response.json())) as any[];
  assert.equal(resumeResults.filter(result=>result.created).length,1);
  assert.equal(resumeResults.filter(result=>result.created===false).length,1);
  const resumed=resumeResults.find(result=>result.created);
  assert.equal(resumed.created,true);assert.equal(resumed.run.executionState,'queued');assert.equal(resumed.run.workflowRunId,null);assert.equal(resumed.run.acceptanceOutcome,null);assert.equal(resumed.run.lastSequence,2);
  const duplicate=await(await f.request(`/v1/runs/${f.run.id}/resume`,'POST',{idempotencyKey:'resume-key-001'})).json() as any;
  assert.equal(duplicate.created,false);
  assert.equal((await f.request(`/v1/runs/${f.run.id}`,'GET',undefined,f.token)).status,401);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',workflow)).status,409);
  assert.equal((await f.request(`/v1/runs/${f.run.id}/workflow`,'POST',{workflowRunId:'5678',workflowUrl:'https://github.com/example/hardwire/actions/runs/5678'})).status,200);
  const saved=await(await f.request(`/v1/runs/${f.run.id}`)).json() as any;
  assert.equal(saved.usage.costUsd,0.25);assert.equal(saved.usage.steps,2);assert.equal(saved.usage.calls,1);assert.equal(saved.usage.reasoningTokens,3);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM workflow_bindings WHERE run_id=?').bind(f.run.id).first<any>()).n,2);
  const leased=await f.DB.prepare('SELECT expires_at FROM runs WHERE id=?').bind(f.run.id).first<any>();
  const projectLease=await f.DB.prepare('SELECT expires_at FROM projects WHERE id=?').bind(f.project.id).first<any>();
  const checkpointLease=await f.DB.prepare('SELECT expires_at FROM artifacts WHERE id=?').bind(metadata.artifactId).first<any>();
  assert.ok(leased.expires_at>Date.now()+30*60_000);assert.ok(leased.expires_at>prior.expires_at);
  assert.equal(projectLease.expires_at,leased.expires_at);assert.equal(checkpointLease.expires_at,leased.expires_at);
});

test('expired run A and exports delete at their cutoff while later run B keeps project source alive',async(t)=>{
  const f=await setup();
  t.mock.method(globalThis,'fetch',async()=>new Response(snapshotTar()));
  const bytes=encoder.encode('run A private evidence');
  const metadata={artifactId:'run-a-evidence',runId:f.run.id,attempt:1,testCaseId:'gunny-30s',sourceHash:'a'.repeat(64),firmwareHash:'b'.repeat(64),scenarioHash:'c'.repeat(64),criteriaHash:f.run.criteriaHash,kind:'serial_log',toolVersions:{wokwi:'1'},capturedAt:new Date().toISOString(),byteSize:bytes.length,sha256:await sha256(bytes),mediaType:'text/plain'};
  await f.request(`/v1/runs/${f.run.id}/artifacts`,'POST',bytes,f.token,{'x-artifact-metadata':JSON.stringify(metadata)});
  await f.request(`/v1/runs/${f.run.id}/finish`,'POST',{executionState:'failed',acceptanceOutcome:'inconclusive',summary:'service_unavailable'},f.token);
  const exported=await(await f.request('/v1/exports','POST',{projectId:f.project.id})).json() as any;
  assert.ok(exported.export);
  const oldExport=await f.DB.prepare('SELECT * FROM exports WHERE id=?').bind(exported.export.id).first<any>();
  const runB=await(await f.request('/v1/runs','POST',{...f.start,idempotencyKey:'run-b-key-0002'})).json() as any;
  await f.request(`/v1/runs/${runB.runId}/workflow`,'POST',{workflowRunId:'5678',workflowUrl:'https://github.com/example/hardwire/actions/runs/5678'});
  await f.request(`/v1/runs/${runB.runId}/reconcile`,'POST',{workflowRunId:'5678',status:'completed',conclusion:'cancelled'});
  assert.equal((await f.DB.prepare('SELECT expires_at FROM exports WHERE id=?').bind(exported.export.id).first<any>()).expires_at,oldExport.expires_at);
  await f.DB.prepare('UPDATE runs SET expires_at=? WHERE id=?').bind(Date.now()-1000,f.run.id).run();
  await f.DB.prepare('UPDATE artifacts SET expires_at=? WHERE run_id=?').bind(Date.now()-1000,f.run.id).run();
  await f.DB.prepare('UPDATE exports SET expires_at=? WHERE id=?').bind(Date.now()-1000,exported.export.id).run();
  assert.equal((await f.request(`/v1/runs/${f.run.id}`)).status,410);
  assert.equal((await f.request('/v1/artifacts/run-a-evidence')).status,410);
  assert.equal((await f.request(exported.export.downloadPath)).status,410);
  f.ARTIFACTS.failDelete=true;await cleanup(f.env);
  assert.equal((await f.DB.prepare('SELECT cleanup_error FROM runs WHERE id=?').bind(f.run.id).first<any>()).cleanup_error,'run_cleanup_failed');
  f.ARTIFACTS.failDelete=false;
  await f.DB.prepare('UPDATE runs SET next_cleanup_at=0').run();await f.DB.prepare('UPDATE exports SET next_cleanup_at=0').run();await cleanup(f.env);
  assert.ok(![...f.ARTIFACTS.objects.keys()].some(key=>key.startsWith(`projects/${f.project.id}/runs/${f.run.id}/`)));
  assert.equal(f.ARTIFACTS.objects.has(oldExport.r2_key),false);
  assert.ok([...f.ARTIFACTS.objects.keys()].some(key=>key.includes('/source/')||key.includes('/baseline/')));
  assert.equal((await f.request(`/v1/runs/${runB.runId}`)).status,200);
  assert.equal((await f.request(`/v1/projects/${f.project.id}`)).status,200);
  const later=await(await f.request('/v1/exports','POST',{projectId:f.project.id})).json() as any;
  const archive=await validateArchive(new Uint8Array(await(await f.request(later.export.downloadPath)).arrayBuffer()));
  assert.ok(!archive.manifest.runs.some((run:any)=>run.runId===f.run.id));assert.ok(archive.manifest.runs.some((run:any)=>run.runId===runB.runId));
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM cleanup_events WHERE run_id=? AND result='run_deleted'").bind(f.run.id).first<any>()).n,1);
});
