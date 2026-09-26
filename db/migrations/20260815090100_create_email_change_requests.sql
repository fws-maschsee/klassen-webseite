-- migrate:up
CREATE TABLE email_change_requests (
  token        TEXT PRIMARY KEY,
  mitglied_id  TEXT NOT NULL REFERENCES mitglieder (id) ON DELETE CASCADE,
  new_email    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE INDEX idx_email_change_requests_mitglied
  ON email_change_requests (mitglied_id);

-- migrate:down
