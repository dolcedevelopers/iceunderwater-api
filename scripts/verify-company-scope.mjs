// Optional SQL regression check with Node 22+. Run npm run build first.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test",
  WP_BASE_URL: "https://iceunderwater.co.za", WP_BRIDGE_SECRET: "test-bridge-secret-32chars!!",
  WC_CONSUMER_KEY: "ck_test", WC_CONSUMER_SECRET: "cs_test",
  JWT_ACCESS_SECRET: "test-access-secret-min-32-characters-long",
  JWT_REFRESH_SECRET: "test-refresh-secret-min-32-characters-long", WC_WEBHOOK_SECRET: "webhook-secret",
});
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE iuw_suppliers (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE iuw_transactions (id TEXT PRIMARY KEY, wc_order_id INTEGER, reference TEXT,
    customer_wp_user_id INTEGER, customer_name TEXT, customer_email TEXT, supplier_id TEXT, supplier_name TEXT,
    items INTEGER, total_cents INTEGER, status TEXT, method TEXT, created_at TEXT, receipt_sent_at TEXT, deleted_at TEXT);
  CREATE TABLE iuw_transaction_lines (id INTEGER PRIMARY KEY, transaction_id TEXT, wc_product_id INTEGER,
    supplier_id TEXT, name TEXT, quantity INTEGER, line_total_cents INTEGER);
  INSERT INTO iuw_suppliers VALUES ('a','Company A'),('b','Company B');`);
const insert = db.prepare("INSERT INTO iuw_transactions VALUES (?, ?, ?, ?, 'Buyer', ?, ?, 'Company B', 2, ?, 'paid', 'Payfast', '2026-11-03', NULL, ?)");
for (const [id, userId, email, supplierId, total, deleted] of [
  ["mixed", 99, "buyer@example.com", "b", 10000, null],
  ["purchase", 11, "a@example.com", "b", 6000, null],
  ["foreign", 99, "buyer@example.com", "b", 7777, null],
  ["email-spoof", 99, "a@example.com", "b", 3333, null],
  ["self", 11, "a@example.com", "a", 1000, null],
  ["deleted", 11, "a@example.com", "a", 9999, "2026-11-03"],
]) insert.run(id, 1, id, userId, email, supplierId, total, deleted);
db.exec(`INSERT INTO iuw_transaction_lines VALUES
  (1,'mixed',1,'a','A product',1,2500),(2,'mixed',2,'b','B product',1,7500),
  (3,'purchase',3,'b','Purchased stock',2,5000),(4,'foreign',4,'b','Foreign product',2,7777),
  (5,'email-spoof',5,'b','Not our purchase',2,3333),(6,'self',6,'a','Own purchase',2,1000),
  (7,'deleted',7,'a','Deleted order',2,9999);`);
const { getPool } = await import("../dist/db/pool.js");
// Execute the repository's real SELECT statements against the fixture without opening a MySQL connection.
getPool().query = async (sql, params) => {
  const statement = db.prepare(sql);
  const bindings = Object.fromEntries(Object.entries(params).filter(([key]) => sql.includes(`:${key}`)));
  return [statement.all(bindings)];
};
const { listCompanyTransactions } = await import("../dist/repositories/transactionRepo.js");
const a = await listCompanyTransactions({ supplierId: "a", wpUserId: 11 });
assert.equal(a.length, 3);
assert.deepEqual(new Set(a.map((row) => row.id)), new Set(["mixed", "purchase", "self"]));
const sale = a.find((row) => row.id === "mixed");
assert.equal(sale.total_cents, 2500);
assert.equal(sale.items, 1);
assert.equal(sale.supplier_id, "a");
assert.equal(sale.transaction_type, "sale");
assert.deepEqual(sale.line_items.map((line) => line.name), ["A product"]);
const purchase = a.find((row) => row.id === "purchase");
assert.equal(purchase.transaction_type, "purchase");
assert.equal(purchase.total_cents, 6000);
assert.deepEqual(purchase.line_items.map((line) => line.name), ["Purchased stock"]);
assert.equal(a.filter((row) => row.id === "self").length, 1);
assert.deepEqual(await listCompanyTransactions({ supplierId: "a", wpUserId: 11, id: "foreign" }), []);
assert.deepEqual(await listCompanyTransactions({ supplierId: "a", wpUserId: 11, reference: "email-spoof" }), []);
const b = await listCompanyTransactions({ supplierId: "b", wpUserId: 12 });
assert.equal(b.find((row) => row.id === "mixed").total_cents, 7500);
assert.equal(b.find((row) => row.id === "purchase").total_cents, 5000);
assert.deepEqual(b.find((row) => row.id === "mixed").line_items.map((line) => line.name), ["B product"]);
db.close();
await getPool().end();
console.log("SQL scope verified: mixed orders, own purchases, foreign IDs, spoofed emails, deleted orders, and duplicate prevention.");
