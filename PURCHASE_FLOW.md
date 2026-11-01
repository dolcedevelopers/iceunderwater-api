# Purchase requests

The app uses `https://iceunderwater-api.onrender.com`. Original API repository:
`C:/Users/calvi/Desktop/iceunderwater` (`dolcedevelopers/iceunderwater-api`).
This folder is a working copy used to prepare and test the update.

## Behaviour

Request. Get Accepted. Pay. Delivered.

- Customers and companies can choose a registered active supplier, one they previously paid, or All suppliers.
- `GET /purchase-requests/suppliers` returns only `{ id, name, city, previous }`. Previous suppliers come from the authenticated buyer's paid request history. A company cannot choose itself.
- Create/resend accepts `targetSupplierId`: a supplier ID selects one supplier; `null` sends to all active suppliers. Omitting it on resend preserves the saved selection. Old requests default to All.
- Only an offered, active supplier can accept. Acceptance is locked in a database transaction, so the first acceptance wins. Resending locks the same request before replacing its offers.
- Only the requester can start checkout after acceptance. The app leaves checkout for the buyer to initiate. It never falls back to unrestricted checkout when this check fails.
- The WordPress bridge validates the accepted request, signed-in buyer, product and quantity before creating the linked order. Existing unrelated website purchases retain their normal checkout flow.
- Verified WooCommerce webhooks must match the accepted request and its items. Transactions belong to the accepting supplier, including when another supplier originally listed the product.
- Delivery assignment requires a confirmed paid transaction belonging to the driver's supplier. The receiving customer's identity comes from the transaction. Request history shows the delivery status.
- All event ticket categories in the app include a complimentary hamper for each attendee.

## Release

1. Apply the reviewed changes to the API repository using `scripts/apply-api-update.ps1` in the parent workspace.
2. Deploy the API and run its normal migration command, including `011_purchase_supplier_selection.sql`.
3. Install the updated `wordpress/iuw-api-bridge.php` in the website's `wp-content/mu-plugins/` directory.
4. Publish an updated mobile app after the API routes and migration are available.
5. Check on staging with two suppliers: request All, accept once, verify the other cannot accept; pay as the requester; assign delivery from the accepting supplier and mark it delivered. Repeat with one selected supplier and a company buyer.

Local checks: backend TypeScript build and Vitest suite, mobile access assertions, Expo web export, and `node scripts/verify-purchase-update.cjs` from the parent workspace. Tests mock persistence; a live payment, MySQL migration, and WordPress checkout still require staging verification.
