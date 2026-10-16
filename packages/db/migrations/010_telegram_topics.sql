-- Holdfast schema v10: bot alerts in forum (topics) supergroups.

-- The topic /buybot was sent in: its buy alerts and floor defences are posted there (null: the group's
-- General topic, or a group without topics).
ALTER TABLE tg_buybots ADD COLUMN IF NOT EXISTS thread_id bigint;

-- The topic /follow or /watch was sent in: that subscription's alerts are posted there (null: the General
-- topic, a group without topics, or a private chat).
ALTER TABLE tg_subscriptions ADD COLUMN IF NOT EXISTS thread_id bigint;
