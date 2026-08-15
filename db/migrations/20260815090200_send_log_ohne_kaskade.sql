-- migrate:up
-- Das Versandprotokoll bleibt stehen, auch wenn die Person geht.
--
-- Bisher zeigte `email_send_log.mitglied_id` mit ON DELETE CASCADE auf
-- `mitglieder`. Jedes Loeschen eines Eintrags riss damit die Belege mit, dass
-- ueberhaupt jemals etwas verschickt wurde. Solange nur ein Mensch von Hand
-- loeschte, fiel das kaum auf. Mit der Loesch-Kaskade am Konto (`user.removed`
-- aus ZITADEL) faellt es sehr auf: Ein Konto wird geloescht, und rueckwirkend
-- sieht es aus, als haette die Einladung zum Elternabend nie jemanden erreicht.
--
-- Das Protokoll ist ein NACHWEIS und kein Personenverzeichnis. Es beantwortet
-- „ist die Rundmail rausgegangen, und an wen davon nicht" — eine Frage, die man
-- Wochen spaeter stellt, wenn jemand sagt, er habe nichts bekommen. Ein
-- Nachweis, den das Loeschen eines Beteiligten entfernt, ist keiner.
--
-- Die Spalte behaelt deshalb ihren WERT und verliert nur den Fremdschluessel:
-- `mitglied_id` steht danach als blosser Text da und zeigt auf nichts mehr.
-- Genau das ist gemeint — die Zeile erzaehlt, was damals geschah, und haengt
-- nicht mehr davon ab, was heute noch existiert.
--
-- WAS DAMIT OFFEN BLEIBT, und zwar ausdruecklich: Die id ist aus dem Namen
-- abgeleitet (`vorname-nachname`), das Protokoll behaelt also einen Namen ueber
-- das Loeschen der Person hinaus. Wie lange ein Nachweis aufbewahrt wird und
-- wann er selbst faellt, ist eine Aufbewahrungsfrage und wird an dieser Stelle
-- NICHT entschieden — dasselbe gilt fuer die Adressen in `list_outbound`. Wer
-- das angeht, braucht eine Frist und ein Aufraeumen, nicht eine Kaskade.
--
-- WARUM EIN TABELLEN-NEUBAU: SQLite kann eine FOREIGN-KEY-Klausel nicht
-- nachtraeglich fallen lassen; `ALTER TABLE` kennt dafuer nichts. Also die
-- Schritte aus der SQLite-Doku wie in 20260804170000 — nur ohne
-- `PRAGMA foreign_keys = OFF`: Auf `email_send_log` zeigt keine andere Tabelle,
-- das `DROP TABLE` reisst also nichts mit, und die Zeilen, die kopiert werden,
-- erfuellen den verbleibenden Fremdschluessel auf `emails` bereits. Deshalb
-- bleibt es bei der Transaktion, die der Runner ohnehin setzt.
CREATE TABLE email_send_log_neu (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_slug    TEXT NOT NULL REFERENCES emails (slug) ON DELETE CASCADE,
  -- Ohne REFERENCES: der historische Empfaenger, nicht ein heutiger Verweis.
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
-- forward-only, absichtlich leer
