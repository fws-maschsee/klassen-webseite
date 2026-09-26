
-- migrate:up

CREATE TABLE bring_lists (
  -- Zufallsschlüssel statt Slug: der Link ist der Zugang, ein Slug wäre erratbar.
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  event_date     TEXT CHECK (event_date IS NULL OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description    TEXT,
  categories     TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days >= 1),
  delete_at      TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bring_lists_delete_at ON bring_lists (delete_at);

CREATE TABLE bring_entries (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES bring_lists (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  category   TEXT,
  item       TEXT NOT NULL,
  amount     TEXT,
  owner_sub  TEXT,
  edit_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bring_entries_list ON bring_entries (list_id, created_at);

-- migrate:down
