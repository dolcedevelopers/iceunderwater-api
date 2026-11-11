ALTER TABLE iuw_purchase_requests DROP COLUMN fulfilment_type, DROP COLUMN location_address,
  DROP COLUMN location_latitude, DROP COLUMN location_longitude;
ALTER TABLE iuw_suppliers DROP COLUMN latitude, DROP COLUMN longitude, DROP COLUMN service_radius_km;
