-- Clinic booking schema. Run once: psql "$DATABASE_URL" -f schema.sql

CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL,
  -- The exact strings the client sent, so responses echo them back unchanged.
  start_raw text NOT NULL,
  end_raw   text NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial UNIQUE,  -- insertion order, used for "oldest first" and cursors
  id         text PRIMARY KEY,
  slot_id    text NOT NULL REFERENCES slots (id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,     -- stored trimmed and lower-cased
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: the database itself allows at most one confirmed booking per slot,
-- so two requests at the same instant can't both win. Cancelled rows don't count.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq);

-- Level 4: one row per Idempotency-Key, written in the same transaction as the booking.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  status_code  int NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Level 5: every booking attempt, per email, for a sliding one-minute window.
CREATE TABLE IF NOT EXISTS booking_attempts (
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_at_idx ON booking_attempts (email, at);
