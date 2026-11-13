ALTER TABLE iuw_purchase_requests ADD COLUMN refund_status VARCHAR(16) NULL, ADD COLUMN refund_reason TEXT NULL, ADD COLUMN refund_requested_at DATETIME(3) NULL;
