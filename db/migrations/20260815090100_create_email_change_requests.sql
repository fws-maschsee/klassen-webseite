-- migrate:up
-- Eine offene Adressaenderung, die noch NICHT gilt.
--
-- WARUM EINE EIGENE TABELLE und kein zweites Feld an `mitglieder`: Solange die
-- neue Adresse unbestaetigt ist, hat sie im Adressbuch nichts verloren. Ein
-- Feld `email_neu` neben `email` waere genau der Zustand, den irgendeine
-- Abfrage irgendwann versehentlich mitliest — `SELECT *` in einer Auswertung,
-- eine Oberflaeche, die „die neuere" nimmt, ein Export. Was nicht gilt, steht
-- nicht in der Tabelle, in der das Gueltige steht.
--
-- WARUM ES DIE BESTAETIGUNG UEBERHAUPT GIBT: Die Zustelladresse entscheidet,
-- WOHIN die Elternpost geht. Ohne Bestaetigung koennte jemand die Post einer
-- anderen Familie auf die eigene Adresse umleiten, und der Betroffene merkte es
-- erst daran, dass nichts mehr kommt — also spaet und ohne Anhaltspunkt. Die
-- Mail geht deshalb an die NEUE Adresse: nur wer sie wirklich liest, kann
-- bestaetigen.
CREATE TABLE email_change_requests (
  -- Der Schluessel aus dem Link. 32 Byte aus `randomBytes`, base64url.
  --
  -- Im Klartext und nicht als Hash: Er liegt in derselben Datei wie das
  -- Adressbuch selbst. Wer sie lesen kann, kann die Adresse ohnehin direkt
  -- aendern — ein Hash schuetzte hier vor niemandem, der nicht schon drin ist,
  -- und kostete die Nachvollziehbarkeit beim Nachsehen. Dieselbe Ueberlegung
  -- wie bei `list_settings_tokens`.
  token        TEXT PRIMARY KEY,
  mitglied_id  TEXT NOT NULL REFERENCES mitglieder (id) ON DELETE CASCADE,
  -- Normalisiert (kleingeschrieben), wie `normalizeEmail`.
  new_email    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Der Link laeuft ab: sieben Tage. Kurz genug, dass ein abgefangener Link
  -- nicht monatelang scharf bleibt, lang genug fuer einen Urlaub.
  expires_at   TEXT NOT NULL,
  -- Gesetzt beim Einloesen. Der Link ist damit EINMAL benutzbar: das Einloesen
  -- ist ein `UPDATE ... WHERE confirmed_at IS NULL`, und wer damit eine Zeile
  -- aendert, hat den Zuschlag. Die Zeile bleibt danach stehen, damit ein
  -- zweiter Klick „schon eingeloest" sagen kann statt „unbekannt" — der
  -- Unterschied zwischen „hat geklappt" und „da stimmt etwas nicht".
  confirmed_at TEXT
);

CREATE INDEX idx_email_change_requests_mitglied
  ON email_change_requests (mitglied_id);

-- migrate:down
-- forward-only, absichtlich leer
