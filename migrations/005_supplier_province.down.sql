ALTER TABLE iuw_suppliers DROP COLUMN province;
DELETE FROM iuw_schema_migrations WHERE id = '005_supplier_province';
