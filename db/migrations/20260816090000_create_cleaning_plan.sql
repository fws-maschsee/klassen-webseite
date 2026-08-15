-- Der Putzplan zieht aus der YAML-Datei des Klassen-Repos in die Datenbank.
--
-- Vorher stand die Einteilung als `src/content/putzplan.yaml` im Klassen-Repo
-- und kannte nur Familiennamen (`morzynski`). Sie konnte deshalb niemanden
-- anschreiben: Die Menschen stehen im Adressbuch (`mitglieder`), und zwischen
-- beidem gab es keine Verbindung. Ein Tausch zwischen zwei Familien war ein
-- Commit plus Deploy — zehn Minuten fuer etwas, das Eltern in einer Minute
-- untereinander ausmachen. Und ein Familienname, der einmal in git steht,
-- bleibt in der Historie.
--
-- Eine FAMILIE ist hier keine neue Tabelle, sondern eine GRUPPE nach der
-- Konvention `familie-<slug>`. Das bestehende Gruppenmodell loest bereits
-- Gruppe -> Personen -> Adressen auf, rekursiv ueber Untergruppen, und ist
-- getestet. Ein zweites Personenmodell danebenzusetzen hiesse, dieselbe
-- Aufloesung ein zweites Mal zu bauen und ab dem naechsten Umzug zwei
-- Wahrheiten darueber zu haben, wer zu einer Familie gehoert.

-- migrate:up

-- Ein Termin des Putzplans.
--
-- Der SCHLUESSEL ist das Datum und keine laufende Nummer. Das ist die
-- Bezeichnung, die auch Menschen benutzen ("tausch den 21.8. mit dem 4.9."),
-- und es macht den Import aus der YAML von selbst idempotent: Ein zweiter Lauf
-- trifft dieselben Zeilen. Der Preis ist, dass es keine zwei Termine am selben
-- Tag geben kann — bei einer woechentlichen Einteilung ist das keine
-- Einschraenkung, sondern die Zusicherung, die die Abstandsregel weiter unten
-- ueberhaupt erst eindeutig macht: "vier Termine Abstand" setzt eine
-- Reihenfolge voraus, und zwei Termine am selben Tag haetten keine.
--
-- `date` ist TEXT im Format `JJJJ-MM-TT`, nicht als Zeitstempel. Ein Putztermin
-- ist ein reines Datum ohne Uhrzeit; als Zeitstempel gespeichert laege er in
-- jeder Zeitzone westlich von UTC lokal einen Tag frueher, und die Tabelle
-- nennte einen Termin, zu dem niemand kommt. Der CHECK laesst nur genau dieses
-- Format zu, damit ein `2026-8-1` gar nicht erst hineinkommt — es sortierte
-- sich als Zeichenkette falsch ein.
CREATE TABLE cleaning_dates (
  date       TEXT PRIMARY KEY
             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Freitext fuer die Spalte "Anmerkungen", z.B. "(Do, da Fr Feiertag)".
  -- Gehoert zum DATUM und nicht zu den Familien: Beim Tausch zweier Termine
  -- bleibt die Anmerkung stehen, denn der Feiertag verschiebt sich nicht mit.
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

-- Wer an einem Termin putzt. Eine Zeile je Familie, also zwei je Termin.
--
-- `group_key` zeigt auf die Whitelist `groups` — dieselbe Tabelle, aus der
-- Verteiler und Mailinglisten ihre Empfaenger holen. Damit ist die Verbindung
-- zum Adressbuch da, an der es vorher fehlte: `familie-morzynski` ist eine
-- Gruppe, ihre Mitglieder sind Zeilen in `mitglieder`, und die haben Adressen.
--
-- ON DELETE RESTRICT und nicht CASCADE: Wird eine Familiengruppe geloescht,
-- waehrend sie noch im Plan steht, soll das SCHEITERN. Mit CASCADE bliebe der
-- Termin mit einer Familie zurueck — ein Plan, der vollstaendig aussieht und
-- an dem eine Familie fehlt, ist genau der Ausfall, den niemand bemerkt.
--
-- Der Primaerschluessel (date, group_key) ist zugleich die zweite der vier
-- Planregeln: Dieselbe Familie kann an einem Termin nicht zweimal stehen. Die
-- uebrigen drei Regeln lassen sich in SQLite nicht als Constraint ausdruecken
-- und stehen deshalb im Schreibpfad, siehe `src/lib/db/putzplan.ts`.
CREATE TABLE cleaning_assignments (
  date       TEXT NOT NULL REFERENCES cleaning_dates (date) ON DELETE CASCADE ON UPDATE CASCADE,
  group_key  TEXT NOT NULL REFERENCES groups (key) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (date, group_key)
);

-- Fuer die Frage "wann ist diese Familie das naechste Mal dran?", die der
-- Erinnerungsdienst je Familie stellt.
CREATE INDEX idx_cleaning_assignments_group ON cleaning_assignments (group_key);

-- migrate:down
-- forward-only, absichtlich leer
