ALTER TABLE iuw_purchase_requests
  ADD COLUMN target_supplier_id VARCHAR(64) NULL AFTER requester_supplier_id;
