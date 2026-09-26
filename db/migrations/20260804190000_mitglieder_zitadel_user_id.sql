-- migrate:up
ALTER TABLE mitglieder ADD COLUMN zitadel_user_id TEXT;

-- UNIQUE als Index, weil ADD COLUMN kein UNIQUE annimmt.
CREATE UNIQUE INDEX idx_mitglieder_zitadel_user_id
  ON mitglieder (zitadel_user_id);

UPDATE mitglieder
   SET zitadel_user_id = substr(id, length('zitadel-') + 1)
 WHERE id LIKE 'zitadel-%';

-- migrate:down
