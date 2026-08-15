-- migrate:up
-- `users` = wer sich hier ANMELDEN kann, und `mitglieder.user_sub` = welcher
-- Adressbuch-Eintrag von diesem Konto verwaltet wird.
--
-- WAS DAS NICHT IST: die Spiegelung. Die hat aus ZITADEL heraus das Adressbuch
-- BESCHRIEBEN — sie holte die Menge aller Grant-Inhaber, legte Eintraege an,
-- aenderte sie und loeschte sie wieder, ungefragt und ohne dass eine Oberflaeche
-- es zeigte. Sie ist am 07.08. entfernt worden (20260807120000) und kommt nicht
-- zurueck.
--
-- Der Bezug hier beantwortet eine ANDERE Frage. Er sagt: „Dieses Konto verwaltet
-- diesen Eintrag." Er sagt NICHT, wer Post bekommt — das entscheidet weiterhin
-- allein die Gruppenzugehoerigkeit (`group_memberships`), und die setzt ein
-- Mensch. Ein frisch angelegter Eintrag steht deshalb in KEINER Gruppe, und das
-- ist kein Versehen, das jemand spaeter „nachziehen" muesste.
--
-- Drei Unterschiede zur Spiegelung, an denen man sie auseinanderhaelt:
--
--   1. Er entsteht nur fuer die Person, die GERADE SELBST da ist, mit ihrer
--      eigenen, schon bewiesenen Sitzung. Es gibt keinen Aufruf, der die Menge
--      aller Konten holt (`usersWithRole` ist und bleibt entfernt).
--   2. Er traegt keine Zugehoerigkeit. Kein Verteiler, keine Gruppe, keine
--      Berechtigung haengt an ihm.
--   3. Er nimmt niemandem etwas. Ein entzogener Grant loescht weiterhin keinen
--      Eintrag; das tut nur das ausdrueckliche Loeschen des KONTOS (Webhook
--      `user.removed`) oder ein Mensch.
--
-- `sub` ALS SCHLUESSEL: Das ist die stabile Nutzerkennung aus dem ID-Token.
-- Namen und Anmeldeadressen aendern sich (Heirat, neuer Anbieter), sie nicht.
-- Genau dieselbe Ueberlegung stand schon in 20260804190000 — nur haengt der
-- Schluessel jetzt an einer eigenen Tabelle statt am Adressbuch, und die
-- Richtung ist umgekehrt: das Konto zeigt nicht auf den Eintrag, der Eintrag
-- zeigt auf das Konto.
CREATE TABLE users (
  -- ZITADEL-`sub` aus dem ID-Token.
  sub           TEXT PRIMARY KEY,
  -- Die Adresse, MIT DER sich jemand anmeldet. Nicht zwingend die Adresse, an
  -- die Post geht — das ist `mitglieder.email`, und sie ist ab dem Anlegen frei
  -- aenderbar (siehe email_change_requests). Anmeldung und Information sind
  -- verschiedene Dinge.
  login_email   TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  -- Erstes und letztes Gesehenwerden. Das erste beantwortet „seit wann gibt es
  -- dieses Konto hier", das letzte „wer war lange nicht mehr da" — die einzige
  -- Grundlage, auf der jemand aufraeumen kann, ohne zu raten.
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_users_login_email ON users (login_email);

-- ON DELETE CASCADE, und das ist die halbe Loesch-Kaskade: Faellt das Konto
-- (ZITADEL-Ereignis `user.removed`), faellt der von ihm verwaltete
-- Adressbuch-Eintrag mit — und an dem haengen per CASCADE schon heute
-- Gruppenzuordnungen und Opt-outs. Eine Kette aus Fremdschluesseln statt einer
-- Liste von Hand-Anweisungen: Wer morgen eine Tabelle an `mitglieder` haengt,
-- bekommt das Loeschen geschenkt und kann es nicht vergessen.
--
-- SQLite erlaubt REFERENCES in `ADD COLUMN` nur mit Vorgabewert NULL. Das passt
-- genau: Eintraege OHNE Konto sind der NORMALFALL und bleiben es — Grosseltern,
-- Lehrkraefte, das Schulbuero, alles aus der Klassenliste Abgeschriebene. Die
-- haben keinen Zugang und sollen trotzdem Post bekommen.
ALTER TABLE mitglieder ADD COLUMN user_sub TEXT REFERENCES users (sub) ON DELETE CASCADE;

-- Ein Konto verwaltet HOECHSTENS EINEN Eintrag. UNIQUE als eigener Index, weil
-- `ADD COLUMN` kein UNIQUE annimmt; er laesst beliebig viele NULL zu, verbietet
-- aber denselben `sub` an zwei Eintraegen. Sonst waere nach einer
-- Adressaenderung nicht mehr entscheidbar, welcher der beiden „der eigene" ist —
-- und die Loesch-Kaskade traefe zwei Familien statt einer.
CREATE UNIQUE INDEX idx_mitglieder_user_sub ON mitglieder (user_sub);

-- migrate:down
-- forward-only, absichtlich leer
