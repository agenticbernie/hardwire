PRAGMA foreign_keys = ON;

CREATE TABLE projects (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
 source_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 cleanup_state TEXT NOT NULL DEFAULT 'pending', cleanup_attempts INTEGER NOT NULL DEFAULT 0,
 cleanup_error TEXT, next_cleanup_at INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
);
CREATE INDEX projects_expiry ON projects(expires_at, next_cleanup_at);
CREATE TABLE tasks (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), project_id TEXT NOT NULL REFERENCES projects(id),
 material_json TEXT NOT NULL, approval_hash TEXT NOT NULL, criteria_hash TEXT NOT NULL, approved_at INTEGER, created_at INTEGER NOT NULL,
 PRIMARY KEY(id,version)
);
CREATE TABLE criteria (
 task_id TEXT NOT NULL, task_version INTEGER NOT NULL, id TEXT NOT NULL, required INTEGER NOT NULL,
 definition_json TEXT NOT NULL, PRIMARY KEY(task_id,task_version,id),
 FOREIGN KEY(task_id,task_version) REFERENCES tasks(id,version)
);
CREATE TRIGGER sequential_task_revisions BEFORE INSERT ON tasks BEGIN
 SELECT CASE WHEN NEW.version != COALESCE((SELECT MAX(version)+1 FROM tasks WHERE id=NEW.id),1)
 THEN RAISE(ABORT,'task_revision_conflict') END;
END;
CREATE TABLE runs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id TEXT NOT NULL,
 task_id TEXT NOT NULL, task_version INTEGER NOT NULL, approval_hash TEXT NOT NULL, criteria_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, execution_state TEXT NOT NULL DEFAULT 'queued'
 CHECK(execution_state IN ('queued','preparing','coding','building','simulating','evaluating','repairing','needs_decision','completed','failed','cancelled','interrupted')),
 acceptance_outcome TEXT CHECK(acceptance_outcome IN ('passed','failed','inconclusive')),
 reason TEXT, finish_id TEXT, workflow_run_id TEXT, workflow_url TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
 last_event_seq INTEGER NOT NULL DEFAULT 0, current_attempt INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, ended_at INTEGER, expires_at INTEGER NOT NULL,
 cleanup_attempts INTEGER NOT NULL DEFAULT 0, cleanup_error TEXT, next_cleanup_at INTEGER NOT NULL DEFAULT 0,
 UNIQUE(task_id,idempotency_key), FOREIGN KEY(task_id,task_version) REFERENCES tasks(id,version)
);
CREATE UNIQUE INDEX one_active_run_per_founder ON runs(owner_id)
 WHERE execution_state NOT IN ('completed','failed','cancelled','interrupted');
CREATE UNIQUE INDEX one_workflow_run ON runs(workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE TABLE attempts (
 run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 4),
 state TEXT NOT NULL, source_hash TEXT, firmware_hash TEXT, scenario_hash TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,attempt)
);
CREATE TABLE events (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL CHECK(sequence>0),
 workflow_run_id TEXT,
 event_json TEXT NOT NULL, event_hash TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(run_id,sequence)
);
CREATE TRIGGER ordered_events BEFORE INSERT ON events BEGIN
 SELECT CASE WHEN NEW.workflow_run_id IS NOT (SELECT workflow_run_id FROM runs WHERE id=NEW.run_id)
 THEN RAISE(ABORT,'workflow_generation_mismatch') END;
 SELECT CASE WHEN NEW.sequence <= (SELECT last_event_seq FROM runs WHERE id=NEW.run_id)
 THEN RAISE(ABORT,'stale_event_sequence') END;
 SELECT CASE WHEN (SELECT execution_state FROM runs WHERE id=NEW.run_id) IN ('completed','failed','cancelled','interrupted')
 THEN RAISE(ABORT,'terminal_run') END;
END;
CREATE TRIGGER advance_event_sequence AFTER INSERT ON events BEGIN
 UPDATE runs SET last_event_seq=NEW.sequence WHERE id=NEW.run_id;
END;
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), project_id TEXT NOT NULL REFERENCES projects(id),
 attempt INTEGER NOT NULL, kind TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE, workflow_run_id TEXT,
 metadata_json TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, checkpoint_sequence INTEGER
);
CREATE TRIGGER active_artifact_generation BEFORE INSERT ON artifacts BEGIN
 SELECT CASE WHEN NEW.workflow_run_id IS NOT (SELECT workflow_run_id FROM runs WHERE id=NEW.run_id)
 OR (SELECT execution_state FROM runs WHERE id=NEW.run_id) IN ('completed','failed','cancelled','interrupted')
 THEN RAISE(ABORT,'workflow_generation_mismatch') END;
END;
CREATE TABLE test_results (
 run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL, criterion_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','inconclusive')), result_json TEXT NOT NULL,
 event_id TEXT NOT NULL REFERENCES events(id), PRIMARY KEY(run_id,attempt,criterion_id)
);
CREATE TABLE usage (
 event_id TEXT PRIMARY KEY REFERENCES events(id), run_id TEXT NOT NULL REFERENCES runs(id),
 input_tokens REAL NOT NULL DEFAULT 0, output_tokens REAL NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
 actions_seconds REAL NOT NULL DEFAULT 0, wokwi_seconds REAL NOT NULL DEFAULT 0, artifact_bytes REAL NOT NULL DEFAULT 0,
 reasoning_tokens REAL NOT NULL DEFAULT 0, cache_read_tokens REAL NOT NULL DEFAULT 0, cache_write_tokens REAL NOT NULL DEFAULT 0,
 steps INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, cumulative INTEGER NOT NULL DEFAULT 0
);
-- Founder-only cumulative resource ledger. This deliberately contains no project/run IDs or content,
-- so measured PoC totals survive the 72-hour deletion of project and run records.
CREATE TABLE poc_usage_totals (
 owner_id TEXT PRIMARY KEY,
 input_tokens REAL NOT NULL DEFAULT 0, output_tokens REAL NOT NULL DEFAULT 0,
 reasoning_tokens REAL NOT NULL DEFAULT 0, cache_read_tokens REAL NOT NULL DEFAULT 0,
 cache_write_tokens REAL NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0,
 calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
 actions_seconds REAL NOT NULL DEFAULT 0, wokwi_seconds REAL NOT NULL DEFAULT 0,
 artifact_bytes INTEGER NOT NULL DEFAULT 0, run_count INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
CREATE TABLE exports (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), r2_key TEXT NOT NULL UNIQUE,
 manifest_json TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 cleanup_attempts INTEGER NOT NULL DEFAULT 0, cleanup_error TEXT, next_cleanup_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE runner_sessions (
 token_hash TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), expires_at INTEGER NOT NULL,
 oidc_jti TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, workflow_run_id TEXT
);
CREATE TABLE cleanup_events (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, attempted_at INTEGER NOT NULL,
 result TEXT NOT NULL, error_code TEXT, retry_at INTEGER, deletion_lag_seconds REAL, run_id TEXT, export_id TEXT
);
CREATE TABLE project_files (
 project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, media_type TEXT NOT NULL,
 PRIMARY KEY(project_id,path)
);
CREATE TABLE import_history (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), manifest_json TEXT NOT NULL
);
CREATE TABLE workflow_bindings (
 workflow_run_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), workflow_url TEXT NOT NULL,
 attached_at INTEGER NOT NULL, ended_at INTEGER, execution_state TEXT
);
CREATE TABLE resume_requests (
 run_id TEXT NOT NULL REFERENCES runs(id), idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL,
 prior_workflow_run_id TEXT, prior_ended_at INTEGER, checkpoint_sequence INTEGER NOT NULL,
 PRIMARY KEY(run_id,idempotency_key)
);
CREATE TRIGGER resume_interrupted_only BEFORE INSERT ON resume_requests BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND execution_state='interrupted')
 THEN RAISE(ABORT,'resume_requires_interrupted_run') END;
END;
