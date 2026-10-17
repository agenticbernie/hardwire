import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Bucket, Database, Env, Statement } from '../src/types.ts';
import worker from '../src/index.ts';
import { sha256 } from '../src/types.ts';
import { SNAPSHOT_COMMIT } from '../src/snapshot.ts';

export class LocalDatabase implements Database {
  sqlite = new DatabaseSync(':memory:');
  private tail:Promise<unknown>=Promise.resolve();
  constructor() { this.sqlite.exec(readFileSync(new URL('../../../db/migrations/0001_hardwire.sql',import.meta.url),'utf8')); }
  prepare(sql:string): Statement {
    let values: any[] = [];
    const statement: Statement = {
      bind(...input:unknown[]) { values=input; return statement; },
      first: async <T>() => (this.sqlite.prepare(sql).get(...values)??null) as T|null,
      all: async <T>() => ({results:this.sqlite.prepare(sql).all(...values) as T[]}),
      run: async () => ({meta:{changes:Number(this.sqlite.prepare(sql).run(...values).changes)}}),
    };
    return statement;
  }
  batch<T>(statements:Statement[]): Promise<T[]> {
    const pending=this.tail.then(async()=>{
      this.sqlite.exec('BEGIN');
      try { const results=[]; for(const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results as T[]; }
      catch(error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.tail=pending.catch(()=>{});return pending;
  }
}
export class LocalBucket implements Bucket {
  objects = new Map<string,Uint8Array<ArrayBuffer>>();
  failDelete = false;
  async put(key:string,value:Uint8Array|ReadableStream<Uint8Array>):Promise<void> {
    const bytes=value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key,bytes);
  }
  async get(key:string) {
    const bytes=this.objects.get(key);
    return bytes ? {size:bytes.length,body:new Blob([bytes]).stream(),arrayBuffer:async()=>bytes.slice().buffer} : null;
  }
  async delete(keys:string|string[]):Promise<void> { if(this.failDelete) throw new Error('deliberate_delete_failure'); for(const key of Array.isArray(keys)?keys:[keys]) this.objects.delete(key); }
  async list({prefix,cursor,limit=500}:{prefix:string;cursor?:string;limit?:number}) {
    const keys=[...this.objects.keys()].filter(key=>key.startsWith(prefix) && (!cursor||key>cursor)).sort();
    const selected=keys.slice(0,limit);
    return {objects:selected.map(key=>({key})),truncated:keys.length>limit,cursor:selected.at(-1)};
  }
}
export function fixture() {
  const DB=new LocalDatabase(),ARTIFACTS=new LocalBucket();
  const env:Env={DB,ARTIFACTS,DATA_API_TOKEN:'test-service-secret',GITHUB_REPOSITORY:'example/hardwire',GITHUB_WORKFLOW_REF:'example/hardwire/.github/workflows/hardwire-poc.yml@refs/heads/main',OIDC_AUDIENCE:'hardwire-data'};
  async function request(path:string,method='GET',value?:unknown,token=env.DATA_API_TOKEN,headers:Record<string,string>={}) {
    return worker.fetch(new Request(`https://worker.invalid${path}`,{method,headers:{authorization:`Bearer ${token}`,'x-founder-id':'founder',...headers},body:value===undefined?undefined:value instanceof Uint8Array?new Uint8Array(value):JSON.stringify(value)}),env);
  }
  return {env,DB,ARTIFACTS,request};
}
export async function setup(f=fixture()) {
  const project=await(await f.request('/v1/projects','POST',{name:'Test',source:{kind:'gunny-snapshot',commit:SNAPSHOT_COMMIT}})).json() as any;
  const task=await(await f.request('/v1/tasks','POST',{projectId:project.project.id,version:1,objective:'Test objective',allowedPaths:['src/main.cpp'],limits:{timeoutSeconds:60,maxRepairRounds:3,maxUsd:1},criteria:[{id:'serial',required:true,text:'Serial expected',evidence:['serial_log']}]})).json() as any;
  await f.request(`/v1/tasks/${task.task.id}/approve`,'POST',{version:1,approvalHash:task.task.approvalHash});
  const start={taskId:task.task.id,taskVersion:1,approvalHash:task.task.approvalHash,criteriaHash:task.task.criteriaHash,idempotencyKey:'test-key-0001'};
  const run=await(await f.request('/v1/runs','POST',start)).json() as any;
  await f.request(`/v1/runs/${run.runId}/workflow`,'POST',{workflowRunId:'1234',workflowUrl:'https://github.com/example/hardwire/actions/runs/1234'});
  const token='test-runner-session';
  await f.DB.prepare('INSERT INTO runner_sessions(token_hash,run_id,expires_at,oidc_jti,created_at,workflow_run_id) VALUES(?,?,?,?,?,?)').bind(await sha256(new TextEncoder().encode(token)),run.runId,Date.now()+900000,'fixture-jti',Date.now(),'1234').run();
  return {...f,project:project.project,task:task.task,run:run.run,start,token};
}
