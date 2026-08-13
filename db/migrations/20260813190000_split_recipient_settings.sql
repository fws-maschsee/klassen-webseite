-- Zwei Fragen statt einer.
--
-- `mode` warf zusammen, was nicht zusammengehoert: ob jemand Post BEKOMMT, und
-- was mit seiner EIGENEN Nachricht passiert, wenn er an die Liste schreibt. Die
-- beiden sind voneinander unabhaengig — wer abgemeldet ist, darf weiter an den
-- Verteiler schreiben, und gerade dann ist eine Quittung nuetzlich, weil er das
-- Ergebnis sonst nirgends sieht.
--
-- In einer Spalte hiess das ausserdem: Wer sich abmeldet, verliert seine
-- Versand-Einstellung, und beim Wiederanmelden faengt er bei der Vorgabe an.
--
-- migrate:up
ALTER TABLE list_recipient_settings
  ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1
  CHECK (subscribed IN (0, 1));

ALTER TABLE list_recipient_settings
  ADD COLUMN own_mail TEXT NOT NULL DEFAULT 'kopie'
  CHECK (own_mail IN ('kopie', 'bestaetigung', 'nichts'));

-- Die bestehenden Zeilen uebersetzen. `abgemeldet` sagte nichts ueber die
-- eigene Post — solche Zeilen bekommen die Vorgabe.
UPDATE list_recipient_settings
   SET subscribed = CASE WHEN mode = 'abgemeldet' THEN 0 ELSE 1 END,
       own_mail   = CASE WHEN mode = 'abgemeldet' THEN 'kopie' ELSE mode END;

ALTER TABLE list_recipient_settings DROP COLUMN mode;

-- `list_settings_tokens` bleibt, bekommt aber eine engere Aufgabe: Sie traegt
-- nur noch den Schluessel fuer das ABMELDEN ohne Anmeldung, wie es der
-- `List-Unsubscribe`-Header verlangt. Wer raus will, soll dafuer nicht erst ein
-- Konto anlegen muessen.
--
-- Die Einstellungen selbst (Abo an/aus je Liste, Umgang mit der eigenen Post)
-- liegen hinter dem ZITADEL-Login unter `/einstellungen`. Eine zweite
-- Einstellungsseite ohne Anmeldung waere ein zweiter Anmeldemechanismus
-- gewesen, nur per Mail statt per Konto.

-- migrate:down
ALTER TABLE list_recipient_settings
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'kopie'
  CHECK (mode IN ('kopie', 'bestaetigung', 'nichts', 'abgemeldet'));

UPDATE list_recipient_settings
   SET mode = CASE WHEN subscribed = 0 THEN 'abgemeldet' ELSE own_mail END;

ALTER TABLE list_recipient_settings DROP COLUMN own_mail;
ALTER TABLE list_recipient_settings DROP COLUMN subscribed;
