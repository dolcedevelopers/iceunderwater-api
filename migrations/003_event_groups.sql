-- Customer event groups (max 6). Keyed to a WordPress page slug such as
-- military-weekend-experience. Soft-delete groups; member rows are removed with the group.

CREATE TABLE IF NOT EXISTS iuw_event_groups (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  event_key VARCHAR(191) NOT NULL,
  name VARCHAR(120) NOT NULL,
  created_by_wp_user_id BIGINT UNSIGNED NOT NULL,
  members_can_accept TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  KEY idx_iuw_event_groups_event (event_key, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_event_group_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id VARCHAR(64) NOT NULL,
  event_key VARCHAR(191) NOT NULL,
  wp_user_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL DEFAULT '',
  role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
  status ENUM('pending', 'active') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_iuw_event_group_event_user (event_key, wp_user_id),
  UNIQUE KEY uq_iuw_event_group_member (group_id, wp_user_id),
  KEY idx_iuw_event_group_members_group (group_id, status),
  CONSTRAINT fk_iuw_event_group_members_group FOREIGN KEY (group_id) REFERENCES iuw_event_groups (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
