-- migrate:up
CREATE TABLE list_recipient_settings_neu (
  list_address TEXT NOT NULL,
  email        TEXT NOT NULL,
  subscribed   INTEGER NOT NULL DEFAULT 1 CHECK (subscribed IN (0, 1)),
  own_mail     TEXT NOT NULL DEFAULT 'copy'
    CHECK (own_mail IN ('copy', 'confirmation', 'none')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (list_address, email)
);

INSERT INTO list_recipient_settings_neu
       (list_address, email, subscribed, own_mail, updated_at)
SELECT  list_address, email, subscribed,
        CASE own_mail
          WHEN 'kopie'        THEN 'copy'
          WHEN 'bestaetigung' THEN 'confirmation'
          WHEN 'nichts'       THEN 'none'
          -- Sollte nicht vorkommen; die Vorgabe entspricht dem Verhalten ohne Einstellung.
          ELSE 'copy'
        END,
        updated_at
  FROM list_recipient_settings;

DROP INDEX idx_list_recipient_settings_email;
DROP TABLE list_recipient_settings;
ALTER TABLE list_recipient_settings_neu RENAME TO list_recipient_settings;

CREATE INDEX idx_list_recipient_settings_email
  ON list_recipient_settings (email);

-- migrate:down
CREATE TABLE list_recipient_settings_alt (
  list_address TEXT NOT NULL,
  email        TEXT NOT NULL,
  subscribed   INTEGER NOT NULL DEFAULT 1 CHECK (subscribed IN (0, 1)),
  own_mail     TEXT NOT NULL DEFAULT 'kopie'
    CHECK (own_mail IN ('kopie', 'bestaetigung', 'nichts')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (list_address, email)
);

INSERT INTO list_recipient_settings_alt
       (list_address, email, subscribed, own_mail, updated_at)
SELECT  list_address, email, subscribed,
        CASE own_mail
          WHEN 'copy'         THEN 'kopie'
          WHEN 'confirmation' THEN 'bestaetigung'
          WHEN 'none'         THEN 'nichts'
          ELSE 'kopie'
        END,
        updated_at
  FROM list_recipient_settings;

DROP INDEX idx_list_recipient_settings_email;
DROP TABLE list_recipient_settings;
ALTER TABLE list_recipient_settings_alt RENAME TO list_recipient_settings;

CREATE INDEX idx_list_recipient_settings_email
  ON list_recipient_settings (email);
