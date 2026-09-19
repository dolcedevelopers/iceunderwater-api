ALTER TABLE iuw_refresh_tokens DROP INDEX idx_iuw_refresh_owner_client;
ALTER TABLE iuw_refresh_tokens
  DROP COLUMN owner_key,
  DROP COLUMN client_kind;
