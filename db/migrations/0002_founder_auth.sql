CREATE TABLE founder_sessions (
 token_hash TEXT PRIMARY KEY,
 csrf_token TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX founder_sessions_expiry ON founder_sessions(expires_at);

CREATE TABLE founder_rate_limits (
 bucket_hash TEXT PRIMARY KEY,
 bucket_count INTEGER NOT NULL CHECK(bucket_count>0),
 expires_at INTEGER NOT NULL
);
CREATE INDEX founder_rate_limits_expiry ON founder_rate_limits(expires_at);
