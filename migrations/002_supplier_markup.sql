-- Per-supplier admin markup applied to supplier cost → customer selling price.
ALTER TABLE iuw_suppliers
  ADD COLUMN markup_percent DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER status;
