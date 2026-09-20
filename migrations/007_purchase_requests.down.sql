DROP TABLE IF EXISTS iuw_purchase_request_offers;
DROP TABLE IF EXISTS iuw_purchase_requests;
DROP TABLE IF EXISTS iuw_notifications;
DELETE FROM iuw_schema_migrations WHERE id = '007_purchase_requests';
