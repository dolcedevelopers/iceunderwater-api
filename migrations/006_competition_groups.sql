-- Warrior Kings competition fields on event groups + richer member roster.

ALTER TABLE iuw_event_groups
  ADD COLUMN stage VARCHAR(64) NOT NULL DEFAULT 'group_stage' AFTER members_can_accept,
  ADD COLUMN competition_name VARCHAR(191) NOT NULL DEFAULT 'ICE UNDERWATER Warrior Kings' AFTER stage,
  ADD COLUMN group_photo_url VARCHAR(1024) NOT NULL DEFAULT '' AFTER competition_name;

ALTER TABLE iuw_event_group_members
  ADD COLUMN first_name VARCHAR(120) NOT NULL DEFAULT '' AFTER email,
  ADD COLUMN surname VARCHAR(120) NOT NULL DEFAULT '' AFTER first_name,
  ADD COLUMN phone VARCHAR(40) NOT NULL DEFAULT '' AFTER surname,
  ADD COLUMN photo_url VARCHAR(1024) NOT NULL DEFAULT '' AFTER phone,
  ADD COLUMN is_guest TINYINT(1) NOT NULL DEFAULT 0 AFTER photo_url;

-- Allow guest roster rows (owner-added people without a WP account).
-- Drop unique that forced every member to be a WP user on the event.
ALTER TABLE iuw_event_group_members
  MODIFY COLUMN wp_user_id BIGINT UNSIGNED NULL;

ALTER TABLE iuw_event_group_members
  DROP INDEX uq_iuw_event_group_event_user,
  DROP INDEX uq_iuw_event_group_member;

ALTER TABLE iuw_event_group_members
  ADD UNIQUE KEY uq_iuw_event_group_member_wp (group_id, wp_user_id),
  ADD KEY idx_iuw_event_group_event_user (event_key, wp_user_id);

INSERT IGNORE INTO iuw_schema_migrations (id) VALUES ('006_competition_groups');
