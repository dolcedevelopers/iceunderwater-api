ALTER TABLE iuw_purchase_requests
  DROP KEY idx_iuw_pr_expiry,
  DROP KEY idx_iuw_pr_requester,
  DROP COLUMN resend_count,
  DROP COLUMN expires_at,
  DROP COLUMN requester_supplier_id;

ALTER TABLE iuw_suppliers
  DROP COLUMN address,
  DROP COLUMN registration_number,
  DROP COLUMN vat_number;
