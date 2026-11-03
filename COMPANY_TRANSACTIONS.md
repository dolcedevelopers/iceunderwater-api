# Company transactions

`GET /transactions`, `GET /transactions/:id`, `/me/receipts`, and `/invoices` apply the same company scope.

- Sales require product-line ownership by the authenticated supplier. Item counts, product details, and amounts include only that supplier's lines.
- Purchases require the authenticated company's WordPress user ID on the transaction. Purchases show the full amount paid and the purchased lines.
- `supplierId` query overrides cannot select another company. Matching an email address alone does not grant a company access.
- Company records include `transactionType: "sale" | "purchase"` and `lineItems: [{ productId, name, quantity, total }]`. Monetary values are serialized in rands.
- Direct lookups and receipt email requests repeat the ownership check. Receipt emails go only to the buyer address stored on the order.
- Companies cannot mark payments paid, refund, or change transaction statuses. Admin access remains unchanged.
- Company revenue uses supplier-owned line totals and excludes company purchases.

The app provides a Transactions tab in the company console with All, Sales, Purchases, payment-status, and text filters. The API and app must both be deployed. No new database migration is needed for this transaction change.

Verification: `npm test`, `npm run build`, and, with Node 22+, `node scripts/verify-company-scope.mjs`. The latter executes the actual repository SELECT statements against an in-memory SQL fixture, including mixed-company orders and negative access cases. Live signed-in payment and receipt testing is still needed after deployment.
