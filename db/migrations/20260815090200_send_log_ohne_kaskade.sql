-- migrate:up
-- Neubau, weil SQLite einen Fremdschlüssel nicht nachträglich fallen lassen kann.
CREATE TABLE email_send_log_neu (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_slug    TEXT NOT NULL REFERENCES emails (slug) ON DELETE CASCADE,
  -- Ohne REFERENCES: das Protokoll ist ein Nachweis und darf das Löschen der Person überdauern.
  mitglied_id   TEXT NOT NULL,
  sent_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status        TEXT NOT NULL CHECK (status IN ('sent', 'error', 'skipped', 'queued', 'sending')),
  message_id    TEXT,
  error_message TEXT,
  claimed_at    TEXT
);

INSERT INTO email_send_log_neu
  (id, email_slug, mitglied_id, sent_at, status, message_id, error_message, claimed_at)
  SELECT id, email_slug, mitglied_id, sent_at, status, message_id, error_message, claimed_at
    FROM email_send_log;

DROP TABLE email_send_log;

ALTER TABLE email_send_log_neu RENAME TO email_send_log;

CREATE INDEX idx_send_log_slug_mitglied ON email_send_log (email_slug, mitglied_id);
CREATE INDEX idx_send_log_status        ON email_send_log (status);

-- migrate:down
