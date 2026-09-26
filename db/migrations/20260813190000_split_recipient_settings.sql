-- migrate:up
ALTER TABLE list_recipient_settings
  ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1
  CHECK (subscribed IN (0, 1));

ALTER TABLE list_recipient_settings
  ADD COLUMN own_mail TEXT NOT NULL DEFAULT 'kopie'
  CHECK (own_mail IN ('kopie', 'bestaetigung', 'nichts'));

UPDATE list_recipient_settings
   SET subscribed = CASE WHEN mode = 'abgemeldet' THEN 0 ELSE 1 END,
       own_mail   = CASE WHEN mode = 'abgemeldet' THEN 'kopie' ELSE mode END;

ALTER TABLE list_recipient_settings DROP COLUMN mode;

-- migrate:down
ALTER TABLE list_recipient_settings
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'kopie'
  CHECK (mode IN ('kopie', 'bestaetigung', 'nichts', 'abgemeldet'));

UPDATE list_recipient_settings
   SET mode = CASE WHEN subscribed = 0 THEN 'abgemeldet' ELSE own_mail END;

ALTER TABLE list_recipient_settings DROP COLUMN own_mail;
ALTER TABLE list_recipient_settings DROP COLUMN subscribed;
