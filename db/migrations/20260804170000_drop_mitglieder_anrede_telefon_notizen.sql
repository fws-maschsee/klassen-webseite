-- migrate:up transaction:false
-- Neubau statt DROP COLUMN: SQLite löscht keine Spalte aus einem CHECK. Ohne foreign_keys = OFF (wirkt nur außerhalb
-- einer Transaktion, daher transaction:false) risse DROP TABLE Gruppen, Opt-outs und Versandprotokoll per CASCADE mit.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE mitglieder_neu (
  id         TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO mitglieder_neu (id, first_name, last_name, email, created_at, updated_at)
  SELECT id, first_name, last_name, email, created_at, updated_at FROM mitglieder;

DROP TABLE mitglieder;

ALTER TABLE mitglieder_neu RENAME TO mitglieder;

CREATE INDEX idx_mitglieder_email ON mitglieder (email);

CREATE TRIGGER trg_mitglieder_updated_at
AFTER UPDATE ON mitglieder
FOR EACH ROW
BEGIN
  UPDATE mitglieder SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

COMMIT;

PRAGMA foreign_keys = ON;

-- migrate:down
