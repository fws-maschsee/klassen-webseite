-- migrate:up
CREATE TABLE putzplan_reminders (
  -- Der Primärschlüssel ist die Sperre gegen Doppelversand: wer einfügen kann, hat den Zuschlag.
  termin_date TEXT PRIMARY KEY,

  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  sent_at TEXT,

  recipient_count INTEGER NOT NULL DEFAULT 0
);

-- migrate:down
DROP TABLE putzplan_reminders;
