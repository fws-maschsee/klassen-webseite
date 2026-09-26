-- migrate:up

CREATE TABLE auth_sessions (
  id                TEXT PRIMARY KEY,
  sub               TEXT NOT NULL,
  sid               TEXT,
  email             TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  roles             TEXT NOT NULL DEFAULT '[]',
  refresh_token     TEXT,
  access_expires_at INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refreshed_at      TEXT,
  revoked_at        TEXT
);

CREATE INDEX idx_auth_sessions_sub ON auth_sessions (sub);
CREATE INDEX idx_auth_sessions_sid ON auth_sessions (sid);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

-- migrate:down
