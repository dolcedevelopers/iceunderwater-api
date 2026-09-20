-- Province derived from fixed SA city list; used for company directory filters.

ALTER TABLE iuw_suppliers
  ADD COLUMN province VARCHAR(80) NOT NULL DEFAULT '' AFTER city;

UPDATE iuw_suppliers SET province = CASE
  WHEN LOWER(city) IN ('johannesburg','pretoria','sandton','centurion','midrand','randburg','roodepoort','soweto','benoni','boksburg','germiston','kempton park','alberton','vanderbijlpark','vereeniging') THEN 'Gauteng'
  WHEN LOWER(city) IN ('cape town','stellenbosch','paarl','somerset west','george','knysna','worcester') THEN 'Western Cape'
  WHEN LOWER(city) IN ('durban','pietermaritzburg','umhlanga','ballito','richards bay') THEN 'KwaZulu-Natal'
  WHEN LOWER(city) IN ('port elizabeth','gqeberha','east london','mthatha') THEN 'Eastern Cape'
  WHEN LOWER(city) IN ('bloemfontein','welkom') THEN 'Free State'
  WHEN LOWER(city) IN ('nelspruit','mbombela','witbank','emalahleni') THEN 'Mpumalanga'
  WHEN LOWER(city) IN ('polokwane','tzaneen') THEN 'Limpopo'
  WHEN LOWER(city) IN ('rustenburg','potchefstroom','mahikeng') THEN 'North West'
  WHEN LOWER(city) IN ('kimberley','upington') THEN 'Northern Cape'
  ELSE province
END
WHERE deleted_at IS NULL;

INSERT IGNORE INTO iuw_schema_migrations (id) VALUES ('005_supplier_province');
