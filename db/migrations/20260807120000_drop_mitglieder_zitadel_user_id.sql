-- migrate:up
DROP INDEX idx_mitglieder_zitadel_user_id;

ALTER TABLE mitglieder DROP COLUMN zitadel_user_id;

-- migrate:down
