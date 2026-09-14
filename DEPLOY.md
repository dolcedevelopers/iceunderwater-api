# Deploy on Render

This API must reach the **same MySQL** as `iceunderwater.co.za` and call the site’s
WordPress / WooCommerce REST APIs. Render only hosts the Node process — the DB and
WP stay on your current host (cPanel).

## Before you click Deploy

### 1. WordPress mu-plugin (site)

1. Upload [`wordpress/iuw-api-bridge.php`](wordpress/iuw-api-bridge.php) to  
   `wp-content/mu-plugins/iuw-api-bridge.php`
2. In `wp-config.php` add (use a long random secret; same value as Render’s `WP_BRIDGE_SECRET`):

```php
define('IUW_BRIDGE_SECRET', 'paste-same-secret-as-render');
// Leave empty on first go-live — Render outbound IPs are not static on every plan.
// define('IUW_BRIDGE_ALLOWED_IPS', '');
```

3. Confirm the bridge answers (expect 403 without the secret header — that proves the route exists):

```bash
curl -i -X POST https://iceunderwater.co.za/wp-json/iuw-bridge/v1/verify
```

### 2. Remote MySQL (cPanel)

Render must open a TCP connection to your MySQL host.

1. cPanel → **Remote MySQL** → allow `%` temporarily, or add Render’s outbound ranges once known  
2. Use the **external** MySQL hostname (not `localhost`)  
3. Create two DB users if you can:
   - app user: SELECT/INSERT/UPDATE/DELETE on `iuw_%` + SELECT on needed `wp_%` tables  
   - migrate user: DDL on `iuw_%` only  
4. If the host requires TLS, keep `DATABASE_SSL=true` (already set in `render.yaml`)

Connection string shape:

```text
mysql://USER:PASSWORD@HOST:3306/DATABASE_NAME
```

URL-encode special characters in the password (`@` → `%40`, `#` → `%23`, etc.).

### 3. WooCommerce REST keys

WooCommerce → Settings → Advanced → REST API → Add key:

- Permissions: **Read/Write**
- Copy Consumer key / secret into Render as `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET`

### 4. Generate secrets (locally)

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

You need distinct values for:

| Env var | Notes |
| --- | --- |
| `WP_BRIDGE_SECRET` | Same as `IUW_BRIDGE_SECRET` in wp-config |
| `WC_WEBHOOK_SECRET` | WooCommerce webhook delivery secret |
| `JWT_ACCESS_SECRET` | Or let Render `generateValue` |
| `JWT_REFRESH_SECRET` | Or let Render `generateValue` |

## Create the Render service

**Option A — Blueprint (preferred)**  
Dashboard → New → Blueprint → select this repo → apply [`render.yaml`](render.yaml).  
Fill every `sync: false` variable in the UI.

**Option B — Manual Web Service**

| Field | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm run start:prod` |
| Health check path | `/live` |
| Instance | Starter (or Free for a smoke test; Free sleeps) |

`start:prod` runs migrations (`node dist/db/migrate.js`) then starts the API.  
Migrations need the SQL files under `/migrations` (committed to the repo).

### Env vars checklist

Copy from [`.env.example`](.env.example). Minimum for production:

```
NODE_ENV=production
DATABASE_URL=...
DATABASE_MIGRATE_URL=...   # can equal DATABASE_URL if one user has DDL
DATABASE_SSL=true
WP_BASE_URL=https://iceunderwater.co.za
WP_BRIDGE_SECRET=...
WP_BRIDGE_ALLOWED_IPS=     # empty until you lock IPs
WC_CONSUMER_KEY=ck_...
WC_CONSUMER_SECRET=cs_...
JWT_ACCESS_SECRET=...      # ≥ 32 chars
JWT_REFRESH_SECRET=...
JWT_ACCESS_TTL_SECONDS=43200
JWT_REFRESH_TTL_SECONDS=2592000
WC_WEBHOOK_SECRET=...
CORS_ORIGINS=              # optional for native app; add Expo web origins if needed
```

Render sets `PORT` itself — do not override it.

## After the first deploy succeeds

1. Open `https://YOUR-SERVICE.onrender.com/live` → `{ "status": "ok" }`  
2. Open `https://YOUR-SERVICE.onrender.com/health` → `db` and `wordpress` should be `true`  
3. Open `/docs` for the OpenAPI UI  

### WooCommerce order webhook

WooCommerce → Settings → Advanced → Webhooks → Add:

| Field | Value |
| --- | --- |
| Topic | Order updated (and/or Order created) |
| Delivery URL | `https://YOUR-SERVICE.onrender.com/webhooks/woocommerce/orders` |
| Secret | same as `WC_WEBHOOK_SECRET` |
| API Version | WP REST API Integration v3 |

Place a test order (or re-save an order) and confirm a row appears via  
`GET /transactions` as admin.

### Give the mobile app the URL

Once healthy, the only frontend value you need is the public base URL, e.g.:

```text
https://iceunderwater-api.onrender.com
```

No trailing slash. App wiring is a separate step after you paste that link.

## Common deploy failures

| Symptom | Likely cause |
| --- | --- |
| Build OK, start crash on migrate | Remote MySQL blocked / wrong host / password not URL-encoded |
| `db: false` on `/health` | Firewall / SSL (`DATABASE_SSL=true`) / wrong database name |
| `wordpress: false` | mu-plugin missing, or `WP_BRIDGE_SECRET` mismatch |
| Bridge always 403 | Secret mismatch, or `IUW_BRIDGE_ALLOWED_IPS` set to a non-Render IP |
| “not allowed to create posts as this user” | Live `iuw-api-bridge.php` is stale; copy the repo file to `mu-plugins` and redeploy the API |
| Webhook 401 | `WC_WEBHOOK_SECRET` ≠ WooCommerce webhook secret |
| Free tier “sleeps” | Upgrade to Starter, or accept cold starts |

## Optional hardening after smoke test

1. Set `IUW_BRIDGE_ALLOWED_IPS` / `WP_BRIDGE_ALLOWED_IPS` to Render’s outbound IP (Static Outbound IPs on paid plans)  
2. Tighten Remote MySQL allow-list to that IP only  
3. After the app has a refresh interceptor, drop `JWT_ACCESS_TTL_SECONDS` to `900`
