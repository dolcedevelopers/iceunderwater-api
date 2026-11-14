ALTER TABLE iuw_deliveries
  ADD COLUMN accepted_at DATETIME(3) NULL,
  ADD COLUMN arrived_at DATETIME(3) NULL,
  ADD COLUMN collect_by DATETIME(3) NULL,
  ADD COLUMN recipient_name VARCHAR(160) NULL,
  ADD COLUMN receipt_wp_user_id BIGINT UNSIGNED NULL,
  ADD COLUMN failure_reason VARCHAR(512) NULL,
  ADD COLUMN redelivery_reason VARCHAR(512) NULL,
  ADD COLUMN requested_at DATETIME(3) NULL,
  ADD COLUMN attempt_number INT UNSIGNED NOT NULL DEFAULT 1;

ALTER TABLE iuw_delivery_events ADD COLUMN details TEXT NULL;
