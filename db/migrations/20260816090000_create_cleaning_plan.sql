
-- migrate:up

CREATE TABLE cleaning_dates (
  date       TEXT PRIMARY KEY
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER trg_cleaning_dates_updated_at
AFTER UPDATE ON cleaning_dates
FOR EACH ROW
BEGIN
  UPDATE cleaning_dates SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE date = NEW.date;
END;

CREATE TABLE cleaning_assignments (
  date       TEXT NOT NULL REFERENCES cleaning_dates (date) ON DELETE CASCADE ON UPDATE CASCADE,
  group_key  TEXT NOT NULL REFERENCES groups (key) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (date, group_key)
);

CREATE INDEX idx_cleaning_assignments_group ON cleaning_assignments (group_key);

-- migrate:down
