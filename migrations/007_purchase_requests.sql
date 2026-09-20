-- Accept-then-pay purchase requests + in-app notifications.

CREATE TABLE IF NOT EXISTS iuw_purchase_requests (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  customer_wp_user_id BIGINT UNSIGNED NOT NULL,
  customer_email VARCHAR(255) NOT NULL DEFAULT '',
  wc_product_id BIGINT UNSIGNED NOT NULL,
  product_name VARCHAR(255) NOT NULL DEFAULT '',
  qty INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('open','accepted','checkout_started','paid','cancelled','expired') NOT NULL DEFAULT 'open',
  accepted_supplier_id VARCHAR(64) NULL,
  woo_order_id BIGINT UNSIGNED NULL,
  woo_order_number VARCHAR(64) NULL,
  checkout_url VARCHAR(1024) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  accepted_at DATETIME(3) NULL,
  paid_at DATETIME(3) NULL,
  KEY idx_iuw_pr_customer (customer_wp_user_id, status),
  KEY idx_iuw_pr_supplier (accepted_supplier_id, status),
  KEY idx_iuw_pr_product (wc_product_id, status),
  KEY idx_iuw_pr_woo (woo_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_purchase_request_offers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(64) NOT NULL,
  supplier_id VARCHAR(64) NOT NULL,
  status ENUM('notified','accepted','missed','declined') NOT NULL DEFAULT 'notified',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_iuw_pr_offer (request_id, supplier_id),
  KEY idx_iuw_pr_offer_supplier (supplier_id, status),
  CONSTRAINT fk_iuw_pr_offer_request FOREIGN KEY (request_id) REFERENCES iuw_purchase_requests (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_notifications (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  recipient_kind ENUM('wp','supplier','driver') NOT NULL DEFAULT 'wp',
  recipient_id VARCHAR(64) NOT NULL,
  title VARCHAR(191) NOT NULL,
  body VARCHAR(1024) NOT NULL DEFAULT '',
  kind VARCHAR(64) NOT NULL DEFAULT 'info',
  ref_type VARCHAR(64) NOT NULL DEFAULT '',
  ref_id VARCHAR(64) NOT NULL DEFAULT '',
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_iuw_notif_recipient (recipient_kind, recipient_id, created_at),
  KEY idx_iuw_notif_unread (recipient_kind, recipient_id, read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO iuw_schema_migrations (id) VALUES ('007_purchase_requests');
