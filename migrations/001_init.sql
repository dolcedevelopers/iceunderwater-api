-- ICE UNDERWATER API schema. Touches no wp_* table structure.
-- Money is stored as integer cents (ZAR). Soft-delete where financially relevant.

CREATE TABLE IF NOT EXISTS iuw_schema_migrations (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_suppliers (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  wp_user_id BIGINT UNSIGNED NULL,
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(64) NOT NULL DEFAULT '',
  city VARCHAR(128) NOT NULL DEFAULT '',
  logo_url VARCHAR(1024) NOT NULL DEFAULT '',
  status ENUM('active', 'pending', 'suspended') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_iuw_suppliers_email (email),
  UNIQUE KEY uq_iuw_suppliers_wp_user (wp_user_id),
  KEY idx_iuw_suppliers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_product_owners (
  wc_product_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  supplier_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  KEY idx_iuw_product_owners_supplier (supplier_id),
  CONSTRAINT fk_iuw_product_owners_supplier FOREIGN KEY (supplier_id) REFERENCES iuw_suppliers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_drivers (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  supplier_id VARCHAR(64) NOT NULL,
  wp_user_id BIGINT UNSIGNED NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(64) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL DEFAULT '',
  vehicle VARCHAR(255) NOT NULL DEFAULT '',
  registration VARCHAR(64) NOT NULL DEFAULT '',
  licence VARCHAR(128) NOT NULL DEFAULT '',
  status ENUM('available', 'on-delivery', 'off-duty') NOT NULL DEFAULT 'available',
  active TINYINT(1) NOT NULL DEFAULT 1,
  password_hash VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  KEY idx_iuw_drivers_supplier (supplier_id),
  KEY idx_iuw_drivers_email (email),
  CONSTRAINT fk_iuw_drivers_supplier FOREIGN KEY (supplier_id) REFERENCES iuw_suppliers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_driver_pings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  driver_id VARCHAR(64) NOT NULL,
  lat DOUBLE NOT NULL,
  lng DOUBLE NOT NULL,
  accuracy DOUBLE NULL,
  heading DOUBLE NULL,
  speed DOUBLE NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_iuw_driver_pings_driver_time (driver_id, recorded_at),
  CONSTRAINT fk_iuw_driver_pings_driver FOREIGN KEY (driver_id) REFERENCES iuw_drivers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_deliveries (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  supplier_id VARCHAR(64) NOT NULL,
  driver_id VARCHAR(64) NOT NULL,
  wc_order_id BIGINT UNSIGNED NOT NULL,
  customer_wp_user_id BIGINT UNSIGNED NULL,
  customer_email VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(64) NOT NULL DEFAULT 'assigned',
  eta_minutes INT NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  KEY idx_iuw_deliveries_supplier (supplier_id),
  KEY idx_iuw_deliveries_driver (driver_id),
  KEY idx_iuw_deliveries_order (wc_order_id),
  KEY idx_iuw_deliveries_customer (customer_wp_user_id, status),
  CONSTRAINT fk_iuw_deliveries_supplier FOREIGN KEY (supplier_id) REFERENCES iuw_suppliers (id),
  CONSTRAINT fk_iuw_deliveries_driver FOREIGN KEY (driver_id) REFERENCES iuw_drivers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_delivery_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  delivery_id VARCHAR(64) NOT NULL,
  status VARCHAR(64) NOT NULL,
  note VARCHAR(512) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_iuw_delivery_events_delivery (delivery_id),
  CONSTRAINT fk_iuw_delivery_events_delivery FOREIGN KEY (delivery_id) REFERENCES iuw_deliveries (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_admins (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  wp_user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  role ENUM('owner', 'manager', 'support') NOT NULL DEFAULT 'support',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_iuw_admins_wp_user (wp_user_id),
  UNIQUE KEY uq_iuw_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_customer_flags (
  wp_user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  status ENUM('active', 'blocked') NOT NULL DEFAULT 'active',
  notes VARCHAR(512) NOT NULL DEFAULT '',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_transactions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  wc_order_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(64) NOT NULL,
  customer_wp_user_id BIGINT UNSIGNED NULL,
  customer_name VARCHAR(255) NOT NULL DEFAULT '',
  customer_email VARCHAR(255) NOT NULL DEFAULT '',
  supplier_id VARCHAR(64) NOT NULL DEFAULT '',
  supplier_name VARCHAR(255) NOT NULL DEFAULT '',
  items INT NOT NULL DEFAULT 0,
  total_cents INT NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'ZAR',
  status ENUM('paid', 'pending', 'refunded', 'failed') NOT NULL DEFAULT 'pending',
  method VARCHAR(64) NOT NULL DEFAULT 'Payfast',
  receipt_sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_iuw_transactions_order (wc_order_id),
  KEY idx_iuw_transactions_reference (reference),
  KEY idx_iuw_transactions_supplier (supplier_id),
  KEY idx_iuw_transactions_customer_email (customer_email),
  KEY idx_iuw_transactions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_transaction_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_id VARCHAR(64) NOT NULL,
  wc_product_id BIGINT UNSIGNED NULL,
  supplier_id VARCHAR(64) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL DEFAULT '',
  quantity INT NOT NULL DEFAULT 0,
  line_total_cents INT NOT NULL DEFAULT 0,
  KEY idx_iuw_tx_lines_tx (transaction_id),
  KEY idx_iuw_tx_lines_supplier (supplier_id),
  CONSTRAINT fk_iuw_tx_lines_tx FOREIGN KEY (transaction_id) REFERENCES iuw_transactions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_refresh_tokens (
  jti VARCHAR(64) NOT NULL PRIMARY KEY,
  wp_user_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(32) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  replaced_by VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_iuw_refresh_user (wp_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_wp_user_id BIGINT UNSIGNED NULL,
  actor_role VARCHAR(32) NOT NULL DEFAULT 'guest',
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64) NOT NULL DEFAULT '',
  target_id VARCHAR(64) NOT NULL DEFAULT '',
  ip VARCHAR(64) NOT NULL DEFAULT '',
  before_json JSON NULL,
  after_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_iuw_audit_actor (actor_wp_user_id),
  KEY idx_iuw_audit_target (target_type, target_id),
  KEY idx_iuw_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_email_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  wc_order_id BIGINT UNSIGNED NOT NULL,
  transaction_id VARCHAR(64) NULL,
  status ENUM('queued', 'sent', 'failed') NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(1024) NOT NULL DEFAULT '',
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_iuw_email_jobs_status (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS iuw_category_map (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  alias VARCHAR(255) NOT NULL,
  alias_normalized VARCHAR(255) NOT NULL,
  wc_term_id BIGINT UNSIGNED NULL,
  approved TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_iuw_category_alias (alias_normalized)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
