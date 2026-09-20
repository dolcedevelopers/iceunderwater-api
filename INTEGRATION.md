# App ↔ API integration

Contract source: `Desktop/iceunderwater-mobile` (separate repo from this API).

## Function → endpoint map (`backend.js`)

| App function | Method | Path | Notes |
| --- | --- | --- | --- |
| `listSuppliers(session)` | GET | `/suppliers` | Bearer token |
| `getSupplier(session, id)` | GET | `/suppliers/:id` | |
| `getSupplierBrand(id)` | GET | `/suppliers/:id/brand` | Public; `{ id, name, logo }` only |
| `createSupplier(session, data)` | POST | `/suppliers` | Admin |
| `updateSupplier(session, id, changes)` | PATCH | `/suppliers/:id` | Status stripped for suppliers |
| `deleteSupplier(session, id)` | DELETE | `/suppliers/:id` | Admin |
| `requestSupplierAccount(data)` | — | **removed** | Use `POST /auth/register` (`accountType: "supplier"`) |
| `listPublicProducts()` | GET | `/catalogue/products` | Consoles / brand catalogue |
| `listProducts(session, supplierId?)` | GET | `/products?supplierId=` | |
| `createProduct(session, supplierId, data)` | POST | `/products` | Creates real WC product |
| `updateProduct(session, id, changes)` | PATCH | `/products/:id` | |
| `deleteProduct(session, id)` | DELETE | `/products/:id` | |
| `listDrivers(session, supplierId?)` | GET | `/drivers?supplierId=` | |
| `createDriver(session, supplierId, data)` | POST | `/drivers` | |
| `updateDriver(session, id, changes)` | PATCH | `/drivers/:id` | |
| `deleteDriver(session, id)` | DELETE | `/drivers/:id` | |
| `listCustomers(session)` | GET | `/customers` | Admin |
| `createCustomer(session, data)` | POST | `/customers` | Admin |
| `updateCustomer(session, id, changes)` | PATCH | `/customers/:id` | Admin |
| `deleteCustomer(session, id)` | DELETE | `/customers/:id` | Admin |
| `listAdmins(session)` | GET | `/admins` | |
| `createAdmin(session, data)` | POST | `/admins` | Invite |
| `updateAdmin(session, id, changes)` | PATCH | `/admins/:id` | |
| `deleteAdmin(session, id)` | DELETE | `/admins/:id` | Refuses last owner |
| `listTransactions(session, supplierId?)` | GET | `/transactions?supplierId=&reference=` | |
| `listMyReceipts(session)` | GET | `/me/receipts` | |
| `updateTransaction(session, id, changes)` | PATCH | `/transactions/:id` | Admin |
| `sendReceiptEmail(session, id)` | POST | `/transactions/:id/receipt` | Email from order only |
| `recordAppOrder(...)` | — | **removed** | Woo webhook syncs orders |
| `getAdminOverview(session)` | GET | `/admin/overview` | |
| `getSupplierOverview(session, id)` | GET | `/suppliers/:id/overview` | |
| `listEventGroups(session, eventKey)` | GET | `/event-groups?eventKey=` | Public list; pending visible to acceptor |
| `createEventGroup(session, data)` | POST | `/event-groups` | Customer (owner) or admin |
| `updateEventGroup(session, id, changes)` | PATCH | `/event-groups/:id` | Creator or admin |
| `deleteEventGroup(session, id)` | DELETE | `/event-groups/:id` | Creator or admin |
| `joinEventGroup(session, id)` | POST | `/event-groups/:id/join` | Customer request |
| `leaveEventGroup(session, id)` | POST | `/event-groups/:id/leave` | Member / cancel request |
| `acceptEventGroupJoin(session, id, wpUserId)` | POST | `/event-groups/:id/members/:wpUserId/accept` | Owner, delegated member, or admin |
| `rejectEventGroupJoin(session, id, wpUserId)` | POST | `/event-groups/:id/members/:wpUserId/reject` | Same as accept |
| `removeEventGroupMember(session, id, wpUserId)` | DELETE | `/event-groups/:id/members/:wpUserId` | Creator or admin |
| `resetDemoData()` | — | **removed** | Local mock only |

### Auth (`auth.js`)

| App function | Method | Path |
| --- | --- | --- |
| `signIn({ accountType, email, password })` | POST | `/auth/login` | App sends `client: "mobile"` — kicks other mobile sessions |
| `register({ accountType, ... })` | POST | `/auth/register` | Same `client` field |
| `completeSupplierSignup(...)` | — | **removed** (folded into register) |
| — | POST | `/auth/refresh` `{ refreshToken }` |
| — | POST | `/auth/logout` `{ refreshToken }` |
| — | GET | `/auth/me` |

Session shape from login:

```json
{
  "token": "<access>",
  "accessToken": "<access>",
  "refreshToken": "<refresh>",
  "expiresIn": 43200,
  "role": "supplier",
  "supplierId": "sup-…",
  "user": { "id": "123", "email": "…", "name": "…" }
}
```

## Seams that need app follow-up

### 1. Token lifetime / refresh interceptor (required soon)

API defaults: **12h access**, **30d rotating refresh**. The app stores one token and has no refresh handling yet.

**App work:** on `401` with code `AUTH_REQUIRED`, call `POST /auth/refresh`, retry once, else sign out. Store both tokens. After that lands, API can tighten access to 15 minutes.

### 2. Supplier registration collapse

Replace:

`register()` → `requestSupplierAccount()` → `completeSupplierSignup()`

with a single `POST /auth/register` (`accountType: "supplier"`). Delete `demo-accounts.js` and its import.

### 3. Who creates the transaction

Checkout stays on the site (Store API / Payfast). Do **not** call `recordAppOrder`.

After payment redirect, confirm with:

`GET /transactions?reference={wooOrderNumber}`

Webhook `POST /webhooks/woocommerce/orders` (HMAC) is the system of record.

### 4. Image uploads

`LogoPicker` / product images must `multipart/form-data` upload to:

- `POST /suppliers/:id/logo`
- `POST /products/:id/image`

Response includes hosted WordPress media URL in `logo` / `image`.

### 5. Product categories

App may keep free-text input. Server maps to existing Woo `product_cat` terms; unknown names go to “Pending category” / Uncategorized and wait for admin approval in `iuw_category_map`. Prefer rendering `GET /catalogue/categories` as a picker.

### 6. Two catalogue paths

- Customer shop: keep `src/api/store.js` → Woo Store API (unchanged).
- `GET /catalogue/*`: supplier-aware catalogue for consoles / attribution. Supplier products are real WC products, so the shop picks them up automatically.

### 7. Error mapping

API errors:

```json
{ "status": 403, "code": "ACCESS_DENIED", "message": "…", "requestId": "…" }
```

Map `status === 401` → `AuthRequiredError`, `status === 403` → `AccessError`, using `message`.

### 8. Driver tracking

Endpoints ready (`GET /drivers/:id/track`, `POST /drivers/:id/pings`, deliveries). No app UI yet — separate work.

## Multi-supplier orders

One customer-facing `Transaction` per Woo order (header `supplierId` = majority line cents). Suppliers see orders via **line ownership** (`iuw_transaction_lines`). Settlement: `GET /suppliers/:id/settlement`.
