-- migrate:up
CREATE TABLE users (
  sub           TEXT PRIMARY KEY,
  login_email   TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_users_login_email ON users (login_email);

-- Nullable, weil SQLite REFERENCES in ADD COLUMN nur mit Vorgabe NULL erlaubt; Einträge ohne Konto sind ohnehin der Normalfall.
ALTER TABLE mitglieder ADD COLUMN user_sub TEXT REFERENCES users (sub) ON DELETE CASCADE;

-- UNIQUE als Index, weil ADD COLUMN kein UNIQUE annimmt; sonst träfe die Lösch-Kaskade zwei Einträge.
CREATE UNIQUE INDEX idx_mitglieder_user_sub ON mitglieder (user_sub);

-- migrate:down
