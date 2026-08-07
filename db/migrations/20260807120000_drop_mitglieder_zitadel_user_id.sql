-- migrate:up
-- Die ZITADEL-Nutzernummer faellt aus dem Adressbuch.
--
-- Entscheidung des Betreibers: ZITADEL und das Adressbuch sind ab jetzt
-- vollstaendig getrennte Datenschichten. Es gibt keinen Abgleich mehr — weder
-- auf Knopfdruck (das MCP-Werkzeug `sync_mitglieder` ist entfernt) noch
-- nebenbei (der Aufruf vor jeder eingehenden Listenmail ist entfernt). Wer im
-- Adressbuch steht, hat ein Mensch eingetragen.
--
-- Damit hat die Spalte keinen Verbraucher mehr. Sie stehen zu lassen waere
-- nicht neutral: `zitadel_user_id` war die Verknuepfung, an der die Spiegelung
-- ihre Zeilen wiedererkannte. Solange sie da ist, ist die Wiedereinfuehrung
-- eines Abgleichs eine Handvoll Zeilen weit weg — dieselbe Ueberlegung, aus der
-- 20260804170000 die Spalte `notes` geloescht hat statt sie nur nicht mehr zu
-- befuellen. Und sie ist ein Personenbezug ueber Systemgrenzen hinweg, den
-- niemand mehr braucht.
--
-- ZEILEN GEHEN NICHT VERLOREN. Was faellt, ist AUSSCHLIESSLICH die Spalte:
-- jede Person bleibt mit Name, E-Mail, Zeitstempeln, Gruppenzuordnungen,
-- Opt-outs und Versandprotokoll erhalten. Auch die einst gespiegelten Zeilen —
-- sie sind ab jetzt gewoehnliche Adressbuch-Eintraege und werden nur noch von
-- Hand gepflegt.
--
-- WARUM `DROP COLUMN` GENUEGT und kein Tabellen-Neubau wie in 20260804170000:
-- SQLite verweigert das Loeschen einer Spalte, die in einem CHECK, einer
-- Fremdschluessel-Klausel, einem Trigger-Rumpf oder einer View vorkommt. Bei
-- `salutation` war es der CHECK, deshalb die zwoelf Schritte. Hier ist nichts
-- davon der Fall: `trg_mitglieder_updated_at` schreibt nur `updated_at`, und
-- die verweisenden Tabellen zeigen auf `id`. Es haengt nur ein INDEX daran —
-- und eine indizierte Spalte laesst SQLite ebenfalls nicht fallen, deshalb
-- faellt der Index zuerst. Beides in einer Transaktion, die der Runner setzt.
DROP INDEX idx_mitglieder_zitadel_user_id;

ALTER TABLE mitglieder DROP COLUMN zitadel_user_id;

-- FOLGE, DIE HIERHER GEHOERT, WEIL SIE DATENSCHUTZRELEVANT IST:
-- Bisher entfernte der Abgleich Personen automatisch, sobald ihr Grant wegfiel.
-- Das gibt es nicht mehr. Wer die Klasse verlaesst, bekommt weiter Elternmail,
-- BIS JEMAND DEN EINTRAG VON HAND LOESCHT (`delete_mitglied`, oder
-- `remove_from_group` fuer den Verteiler allein). Personenbezogene Daten stehen
-- damit so lange im Verteiler, wie die Verwaltung sie stehen laesst — das ist
-- eine Pflicht, keine Einstellung. Siehe README.

-- migrate:down
-- forward-only, absichtlich leer
