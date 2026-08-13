-- Was jede Adresse von einer Liste bekommen moechte — und der Schluessel, mit
-- dem sie das selbst einstellen kann, ohne Konto und ohne Anmeldung.
--
-- WARUM EINE EIGENE TABELLE UND NICHT `address_suppressions`:
-- Es gibt sie schon, und `abgemeldet` liesse sich damit ausdruecken. Aber dort
-- stehen Bounces und Beschwerden — Dinge, die das SYSTEM feststellt. Was eine
-- Person WILL, gehoert nicht in denselben Topf: Sonst hebt ein Klick auf der
-- Einstellungsseite eine Bounce-Sperre auf, oder eine harte Zustellsperre sieht
-- aus wie eine Abmeldung. Beide Ebenen greifen unabhaengig voneinander, und
-- beide zaehlen: Wer gebounct ist, bekommt auch mit `kopie` keine Post.
--
-- migrate:up
CREATE TABLE list_recipient_settings (
  -- Localpart der Liste (`alle`, `nureltern`). Je Liste eine eigene
  -- Einstellung: Wer die Elterndiskussion satt hat, soll die Schulinfos
  -- behalten koennen.
  list_address TEXT NOT NULL,

  -- Normalisierte Adresse (kleingeschrieben, wie `normalizeEmail`). Bewusst die
  -- ADRESSE als Schluessel und nicht die Mitglieds-Id: `extra_recipients` sind
  -- Adressen ohne Adressbuch-Eintrag, und auch die sollen sich abmelden koennen.
  email TEXT NOT NULL,

  -- kopie         wie bisher: alles, auch die eigene Mail zurueck
  -- bestaetigung  alles ausser der eigenen Mail; stattdessen eine Quittung,
  --               wenn die eigene Rundmail zugestellt ist
  -- nichts        alles ausser der eigenen Mail, ohne Quittung
  -- abgemeldet    gar keine Post von dieser Liste
  mode TEXT NOT NULL DEFAULT 'kopie'
    CHECK (mode IN ('kopie', 'bestaetigung', 'nichts', 'abgemeldet')),

  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (list_address, email)
);

-- Die Abfrage beim Verteilen lautet „alle Einstellungen DIESER Liste"; der
-- Primaerschluessel bedient sie schon. Dieser Index bedient die andere
-- Richtung: „alles, was diese Adresse eingestellt hat" — die Einstellungsseite.
CREATE INDEX idx_list_recipient_settings_email
  ON list_recipient_settings (email);

-- Der Schluessel fuer die Einstellungsseite. EIN Token je Adresse, nicht je
-- Liste: Die Seite zeigt alle Listen der Klasse auf einmal, und mehrere Token
-- fuer dieselbe Person waeren nur mehr Zettel zum Verlieren.
--
-- Er wird beim ersten Bedarf gewuerfelt und danach nie veraendert. Ein aus
-- einem Secret ABGELEITETER Token waere zustandsfrei gewesen — aber beim
-- naechsten Wechsel des Secrets waeren alle Links in allen schon verschickten
-- Mails tot, und niemand kaeme mehr aus dem Verteiler heraus.
CREATE TABLE list_settings_tokens (
  email      TEXT PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Wann die Quittung fuer diese Rundmail verschickt wurde. NULL heisst „noch
-- nicht". Sie traegt die Idempotenz: Den Zuschlag bekommt, wessen
-- `UPDATE ... WHERE receipt_sent_at IS NULL` eine Zeile aendert. Ohne das
-- bekaeme die Absenderin bei mehreren Arbeitern (oder einem Neustart mitten in
-- der Warteschlange) mehrere Quittungen fuer dieselbe Mail.
ALTER TABLE list_messages ADD COLUMN receipt_sent_at TEXT;

-- migrate:down
DROP TABLE list_settings_tokens;
DROP INDEX idx_list_recipient_settings_email;
DROP TABLE list_recipient_settings;
ALTER TABLE list_messages DROP COLUMN receipt_sent_at;
