-- Mitbringlisten: "Wer bringt was zum Grillfest mit?"
--
-- Eine Liste ist ein Anlass (Grillfest, Weihnachtspicknick), den ein admin
-- ueber MCP anlegt. Die Familien tragen sich selbst ein — auch OHNE Konto, denn
-- viele Eltern nutzen die Seite nicht mit Anmeldung. Der Zugang ist deshalb
-- der Link: `id` ist ein zufaelliger, nicht erratbarer Schluessel und zugleich
-- der Pfad `/public/mitbringen/<id>`. Wer den Link hat, sieht die Liste und
-- traegt ein; wer ihn nicht hat, findet sie nicht.
--
-- Datensparsamkeit: `delete_at` wird beim Anlegen aus Datum und
-- `retention_days` (Vorgabe 180) berechnet; danach loescht der Server die
-- Liste samt Eintraegen von selbst. Eine Mitbringliste ist nach dem Fest
-- wertlos und nennt Familiennamen — beides Gruende, sie nicht liegen zu lassen.

-- migrate:up

CREATE TABLE bring_lists (
  -- Zufallsschluessel (base64url, 16 Zeichen). Absichtlich KEIN Slug aus dem
  -- Titel: "grillfest-2026" waere fuer jeden erratbar, und die Liste liegt
  -- ohne Anmeldung im Netz.
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  -- `JJJJ-MM-TT` oder NULL — dasselbe reine Datum wie beim Putzplan, aus
  -- denselben Gruenden (kein Zeitstempel, keine Zeitzonenverschiebung).
  event_date     TEXT CHECK (event_date IS NULL OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description    TEXT,
  -- JSON-Array von Kategorien ("Salat", "Grillgut", ...). Leer = keine
  -- Kategorien, dann gibt es auf der Seite kein Auswahlfeld.
  categories     TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days >= 1),
  -- ISO-Zeitstempel (dbTimestamp), ab dem die Liste geloescht wird.
  delete_at      TEXT NOT NULL,
  -- Zaehler, der bei JEDER Aenderung an Liste oder Eintraegen steigt. Die
  -- Seite fragt ihn ab und laedt die Eintraege nur nach, wenn er sich
  -- bewegt hat — so sehen alle, was die anderen eintragen, ohne dass der
  -- Server jede Sekunde die ganze Liste neu schreibt.
  revision       INTEGER NOT NULL DEFAULT 0,
  -- ZITADEL-`sub` der Person, die die Liste angelegt hat (ueber MCP).
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bring_lists_delete_at ON bring_lists (delete_at);

-- Ein Eintrag: "Familie Muster bringt 10 Wuerstchen (Grillgut)".
--
-- `owner_sub` ist gesetzt, wenn eine angemeldete Person eingetragen hat; dann
-- darf sie ihren Eintrag spaeter aendern. Ohne Konto bekommt der Browser ein
-- `edit_token`, das dieselbe Rolle spielt — und sonst niemand. Ein admin darf
-- alles korrigieren.
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
-- forward-only, absichtlich leer
