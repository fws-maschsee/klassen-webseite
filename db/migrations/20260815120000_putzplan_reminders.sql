-- Welche Putz-Erinnerung schon raus ist.
--
-- WARUM EINE EIGENE TABELLE UND NICHT `email_send_log`:
-- Dort steht eine Zeile je EMPFAENGER und je Rundmail-Slug; die Idempotenz
-- dort heisst „diese Person hat diese Mail". Hier ist die Einheit eine andere:
-- EIN TERMIN geht genau einmal raus, an wen auch immer an diesem Tag dran ist.
-- Waere die Erinnerung im Send-Log gefuehrt, entschiede die Frage „schon
-- verschickt?" sich pro Adresse — und eine Familie, die zwischen zwei Ticks
-- eine zweite Adresse eintraegt, bekaeme die Erinnerung ein zweites Mal, jetzt
-- an eine Adresse mehr. Der Termin ist die Einheit, also ist der Termin der
-- Schluessel.
--
-- migrate:up
CREATE TABLE putzplan_reminders (
  -- Der Termin als `JJJJ-MM-TT` (derselbe Wert wie `datumIso()` liefert), und
  -- zwar als PRIMAERSCHLUESSEL. Das ist die ganze Absicherung gegen
  -- Doppelversand: Wer den Termin einfuegen kann, hat den Zuschlag, alle
  -- anderen bekommen einen Konflikt und schweigen. Kein Vorher-Nachsehen —
  -- zwischen „steht noch nichts da" und „ich schreibe" passt sonst ein zweiter
  -- Tick, ein zweiter Prozess oder ein Neustart.
  termin_date TEXT PRIMARY KEY,

  -- Wann sich ein Tick den Termin genommen hat. Steht VOR dem Versand fest,
  -- damit ein Absturz mitten im Versand keine zweite Runde ausloest.
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Wann der Versand durch war. NULL heisst „beansprucht, aber nicht fertig" —
  -- entweder laeuft es gerade, oder der Prozess ist dabei gestorben. Nur eine
  -- solche Zeile darf ein spaeterer Tick wieder freigeben (siehe
  -- `gibErinnerungFrei`); eine Zeile mit `sent_at` ist unantastbar.
  sent_at TEXT,

  -- Wie viele Adressen die Erinnerung bekommen haben. Fuer die Frage „ist das
  -- wirklich an alle gegangen?", die sonst niemand mehr beantworten kann:
  -- die Zusammensetzung der Familien aendert sich, die Zahl von damals nicht.
  recipient_count INTEGER NOT NULL DEFAULT 0
);

-- migrate:down
DROP TABLE putzplan_reminders;
