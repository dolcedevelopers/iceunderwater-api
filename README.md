# ICE UNDERWATER API

Node.js + TypeScript REST API for the ICE UNDERWATER Expo app. Hosted separately from the WordPress site, shares the same MySQL database, and performs all WooCommerce **writes** through the official REST API.

## Stack

- Fastify + Zod + TypeScript
- mysql2 (reads may join `wp_*`; writes to commerce data go through Woo/WP REST)
- JWT access + rotating refresh tokens (API-owned after WordPress identity is verified)
- Argon2id for any passwords this API stores (drivers)
- Vitest authorization suite ported from the mobile app

## Quick start

```bash
cp .env.example .env
# fill DATABASE_URL, DATABASE_MIGRATE_URL, WP_*, WC_*, JWT_* secrets

npm install
npm run migrate
npm run dev
```

- API: `http://localhost:4000`
- OpenAPI UI: `http://localhost:4000/docs`
- Health: `GET /health`

## WordPress bridge (one mu-plugin)

Copy [`wordpress/iuw-api-bridge.php`](wordpress/iuw-api-bridge.php) to `wp-content/mu-plugins/` and add to `wp-config.php`:

```php
define('IUW_BRIDGE_SECRET', 'same-as-WP_BRIDGE_SECRET');
define('IUW_BRIDGE_ALLOWED_IPS', 'YOUR.API.SERVER.IP');
```

That file registers roles `iuw_supplier` / `iuw_admin`, verifies credentials, creates users, and triggers WooCommerce’s own customer-invoice email. No other WordPress work is required.

## Migrations

```bash
npm run migrate          # apply
npm run migrate:down     # revert latest
```

Uses `DATABASE_MIGRATE_URL` (DDL-capable). The runtime `DATABASE_URL` user should be DML-only.

## App switch-over

See [`INTEGRATION.md`](INTEGRATION.md). Point `mobile-app/src/api/backend.js` at HTTP calls with the same function names; delete `demo-accounts.js` once supplier/admin login works.

## Authorization

Every private route goes through [`src/authz/permissions.ts`](src/authz/permissions.ts) — the server mirror of the app’s `permissions.js`. Tests in `tests/authz.test.ts` port `verify-access-rules.mjs`.

## Money

Stored and calculated as **integer cents (ZAR)**; serialized as **rands** on `price`, `total`, `spend`.

## Tokens

| Token | TTL (default) | Notes |
| --- | --- | --- |
| Access | 12 hours | Defensible on mobile until the app adds a refresh interceptor |
| Refresh | 30 days | Rotating; reuse revokes the family |

Tighten access to 15 minutes after the app implements refresh (`POST /auth/refresh`).

## POPIA (summary)

| Data | Lawful basis | Retention |
| --- | --- | --- |
| Customer contact + orders | Contract / legitimate interest (fulfililment) | Order/financial records soft-deleted; retain per SA tax rules (~5 years) |
| Supplier/admin accounts | Contract | While active + audit retention |
| Driver live location | Legitimate interest (delivery) | **Auto-purge pings after 90 days** (`DRIVER_PING_RETENTION_DAYS`) |
| Audit log | Legal obligation / security | 2+ years recommended |

Public brand endpoint returns `{ id, name, logo }` only. Logs redact tokens and passwords.

## Deploy on Render

Step-by-step (mu-plugin, remote MySQL, env vars, webhook): see **[`DEPLOY.md`](DEPLOY.md)**.

Blueprint: [`render.yaml`](render.yaml) — build `npm ci && npm run build`, start `npm run start:prod`, health `/live`.

## Deploy notes

- TLS + HSTS at the reverse proxy (Render provides this)
- `trustProxy` is enabled for correct client IPs behind Render
- Set `DATABASE_SSL=true` for remote cPanel MySQL
- Strict `CORS_ORIGINS` when browser clients exist; native Expo often sends no Origin
- Separate DB users for app vs migrate when possible
- Configure a WooCommerce webhook to `POST /webhooks/woocommerce/orders` with `WC_WEBHOOK_SECRET`
- Cron later: purge old `iuw_driver_pings`; retry `iuw_email_jobs`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode |
| `npm run build` / `npm start` | Production build / run (no migrate) |
| `npm run start:prod` | Migrate then start (Render start command) |
| `npm run migrate` / `migrate:prod` | Apply migrations (tsx / compiled) |
| `npm test` | Authz + money tests |
| `npm run lint` | `tsc --noEmit` |
