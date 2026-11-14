ALTER TABLE iuw_delivery_events DROP COLUMN details;
ALTER TABLE iuw_deliveries DROP COLUMN accepted_at, DROP COLUMN arrived_at, DROP COLUMN collect_by,
  DROP COLUMN recipient_name, DROP COLUMN receipt_wp_user_id, DROP COLUMN failure_reason,
  DROP COLUMN redelivery_reason, DROP COLUMN requested_at, DROP COLUMN attempt_number;
