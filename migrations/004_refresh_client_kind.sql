-- Tag refresh tokens by client so a new mobile login can revoke other mobile
-- sessions without touching web / unknown sessions.

ALTER TABLE iuw_refresh_tokens
  ADD COLUMN client_kind VARCHAR(16) NOT NULL DEFAULT 'unknown' AFTER role,
  ADD COLUMN owner_key VARCHAR(96) NOT NULL DEFAULT '' AFTER client_kind;

UPDATE iuw_refresh_tokens
SET owner_key = CONCAT('wp:', wp_user_id)
WHERE (owner_key = '' OR owner_key IS NULL) AND wp_user_id > 0;

CREATE INDEX idx_iuw_refresh_owner_client ON iuw_refresh_tokens (owner_key, client_kind, revoked_at);
