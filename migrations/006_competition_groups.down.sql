ALTER TABLE iuw_event_group_members
  DROP INDEX uq_iuw_event_group_member_wp,
  DROP INDEX idx_iuw_event_group_event_user;

ALTER TABLE iuw_event_group_members
  DROP COLUMN first_name,
  DROP COLUMN surname,
  DROP COLUMN phone,
  DROP COLUMN photo_url,
  DROP COLUMN is_guest;

ALTER TABLE iuw_event_group_members
  MODIFY COLUMN wp_user_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE iuw_event_group_members
  ADD UNIQUE KEY uq_iuw_event_group_event_user (event_key, wp_user_id),
  ADD UNIQUE KEY uq_iuw_event_group_member (group_id, wp_user_id);

ALTER TABLE iuw_event_groups
  DROP COLUMN stage,
  DROP COLUMN competition_name,
  DROP COLUMN group_photo_url;

DELETE FROM iuw_schema_migrations WHERE id = '006_competition_groups';
