ALTER TABLE iuw_suppliers ADD COLUMN latitude DECIMAL(10,7) NULL,
  ADD COLUMN longitude DECIMAL(10,7) NULL,
  ADD COLUMN service_radius_km DECIMAL(7,2) NULL;
ALTER TABLE iuw_purchase_requests ADD COLUMN fulfilment_type VARCHAR(16) NULL,
  ADD COLUMN location_address VARCHAR(512) NULL,
  ADD COLUMN location_latitude DECIMAL(10,7) NULL,
  ADD COLUMN location_longitude DECIMAL(10,7) NULL;
