
-- migrate:up

-- Schichten in Blöcken (z.B. "Freitag · Aufbau"); NULL heißt: alte flache Liste aus `shifts`.
ALTER TABLE shift_lists ADD COLUMN blocks TEXT;

-- migrate:down
