-- migrate:up
CREATE TABLE users (
  sub           TEXT PRIMARY KEY,
  login_email   TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_users_login_email ON users (login_email);

ALTER TABLE mitglieder ADD COLUMN user_sub TEXT REFERENCES users (sub) ON DELETE CASCADE;

CREATE UNIQUE INDEX idx_mitglieder_user_sub ON mitglieder (user_sub);

-- migrate:down
