-- migrate:up
CREATE TABLE list_recipient_settings (
  list_address TEXT NOT NULL,

  email TEXT NOT NULL,

  mode TEXT NOT NULL DEFAULT 'kopie'
    CHECK (mode IN ('kopie', 'bestaetigung', 'nichts', 'abgemeldet')),

  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (list_address, email)
);

CREATE INDEX idx_list_recipient_settings_email
  ON list_recipient_settings (email);

-- Gewürfelt und nie erneuert statt aus einem Secret abgeleitet: ein Secret-Wechsel entwertete sonst alle Abmeldelinks in alten Mails.
CREATE TABLE list_settings_tokens (
  email      TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE list_messages ADD COLUMN receipt_sent_at TEXT;

-- migrate:down
DROP TABLE list_settings_tokens;
DROP INDEX idx_list_recipient_settings_email;
DROP TABLE list_recipient_settings;
ALTER TABLE list_messages DROP COLUMN receipt_sent_at;
