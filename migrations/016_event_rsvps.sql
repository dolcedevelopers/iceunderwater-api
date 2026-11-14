CREATE TABLE IF NOT EXISTS iuw_event_rsvps (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  event_key VARCHAR(80) NOT NULL,
  wp_user_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(254) NOT NULL,
  province VARCHAR(80) NOT NULL,
  city VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'confirmed',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_iuw_rsvp_attendee (event_key, wp_user_id),
  KEY idx_iuw_rsvp_summary (event_key, status, province, city)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
