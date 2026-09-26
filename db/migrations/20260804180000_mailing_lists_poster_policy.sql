-- migrate:up
ALTER TABLE mailing_lists
  ADD COLUMN poster_policy TEXT NOT NULL DEFAULT 'offen'
  CHECK (poster_policy IN ('offen', 'eingeschraenkt'));

-- Bestand bewusst eingeschränkt: 'offen' gilt nur für neue Listen, keine laufende Liste darf durch die Migration offen werden.
UPDATE mailing_lists SET poster_policy = 'eingeschraenkt';

ALTER TABLE mailing_lists RENAME COLUMN extra_senders TO sender_patterns;

-- migrate:down
