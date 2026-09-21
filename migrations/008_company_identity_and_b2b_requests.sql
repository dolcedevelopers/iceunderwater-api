-- Legal identity on the company record (needed on every generated invoice),
-- company-to-company purchase requests, and a bounded acceptance window.

ALTER TABLE iuw_suppliers
  ADD COLUMN vat_number VARCHAR(64) NOT NULL DEFAULT '' AFTER province,
  ADD COLUMN registration_number VARCHAR(64) NOT NULL DEFAULT '' AFTER vat_number,
  ADD COLUMN address VARCHAR(512) NOT NULL DEFAULT '' AFTER registration_number;

ALTER TABLE iuw_purchase_requests
  ADD COLUMN requester_supplier_id VARCHAR(64) NULL AFTER customer_email,
  ADD COLUMN expires_at DATETIME(3) NULL AFTER checkout_url,
  ADD COLUMN resend_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER expires_at,
  ADD KEY idx_iuw_pr_requester (requester_supplier_id, status),
  ADD KEY idx_iuw_pr_expiry (status, expires_at);

-- Existing open requests get a window from their creation time so nothing hangs forever.
UPDATE iuw_purchase_requests
   SET expires_at = DATE_ADD(created_at, INTERVAL 15 MINUTE)
 WHERE expires_at IS NULL;

INSERT IGNORE INTO iuw_schema_migrations (id) VALUES ('008_company_identity_and_b2b_requests');
