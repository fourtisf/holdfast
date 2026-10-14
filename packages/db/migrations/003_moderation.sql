-- Holdfast schema v3: moderation and admin.

-- A hidden coin still exists on pump.fun and keeps paying its holders; Holdfast just stops listing it
-- and withholds its user-supplied content (image, description, links).
ALTER TABLE coins ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS hidden_reason text;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
-- Set when the launch text matched a reserved ticker/name: shown to admins for review.
ALTER TABLE coins ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS coins_visible_created_idx ON coins (created_at DESC) WHERE NOT hidden;

-- User reports (coins now; comments later share the table through target_type).
CREATE TABLE IF NOT EXISTS reports (
  id             bigserial PRIMARY KEY,
  target_type    text NOT NULL CHECK (target_type IN ('coin', 'comment')),
  target_id      text NOT NULL,
  mint           text NOT NULL REFERENCES coins(mint),
  reason         text NOT NULL CHECK (reason IN ('scam', 'impersonation', 'nsfw', 'hate', 'illegal', 'other')),
  details        text NOT NULL DEFAULT '',
  -- sha256(salt ‖ reporter IP): enough to count distinct reporters, not enough to identify anyone.
  reporter_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     text,
  UNIQUE (target_type, target_id, reporter_hash)
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at DESC) WHERE resolved_at IS NULL;

-- Images that may never be uploaded again (sha256 of the file bytes, as stored by POST /uploads/image).
CREATE TABLE IF NOT EXISTS blocked_images (
  sha256      text PRIMARY KEY,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every admin action, for accountability.
CREATE TABLE IF NOT EXISTS moderation_log (
  id          bigserial PRIMARY KEY,
  action      text NOT NULL,
  target      text NOT NULL,
  actor       text NOT NULL,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
