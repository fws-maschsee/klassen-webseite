
-- migrate:up

CREATE TABLE shift_lists (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  event_date     TEXT CHECK (event_date IS NULL OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description    TEXT,
  shifts         TEXT NOT NULL DEFAULT '[]',
  capacity       INTEGER CHECK (capacity IS NULL OR capacity >= 1),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days >= 1),
  delete_at      TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_shift_lists_delete_at ON shift_lists (delete_at);

CREATE TABLE shift_entries (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES shift_lists (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  shift      TEXT NOT NULL,
  note       TEXT,
  owner_sub  TEXT,
  edit_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_shift_entries_list ON shift_entries (list_id, created_at);

-- Die eine als Mitbringliste angelegte Schichtliste (Klasse Wiesen) umziehen; in anderen Klassen trifft das nichts.
INSERT INTO shift_lists (id, title, event_date, description, shifts, capacity, status, retention_days, delete_at, revision, created_by, created_at, updated_at)
  SELECT id, title, event_date, description, categories, NULL, status, retention_days, delete_at, revision, created_by, created_at, updated_at
    FROM bring_lists
   WHERE id = 'hKZZWIVIoh-LQs12';

INSERT INTO shift_entries (id, list_id, name, shift, note, owner_sub, edit_token, created_at, updated_at)
  SELECT id, list_id, name, COALESCE(category, item), amount, owner_sub, edit_token, created_at, updated_at
    FROM bring_entries
   WHERE list_id = 'hKZZWIVIoh-LQs12';

DELETE FROM bring_lists WHERE id = 'hKZZWIVIoh-LQs12';

-- migrate:down
