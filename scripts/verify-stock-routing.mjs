// Optional Node 22+ SQL fixture check. Run npm run build first.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test", WP_BASE_URL: "https://iceunderwater.co.za",
  WP_BRIDGE_SECRET: "test-bridge-secret-32chars!!", WC_CONSUMER_KEY: "ck_test", WC_CONSUMER_SECRET: "cs_test",
  JWT_ACCESS_SECRET: "test-access-secret-min-32-characters-long", JWT_REFRESH_SECRET: "test-refresh-secret-min-32-characters-long", WC_WEBHOOK_SECRET: "webhook-secret",
});
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_type TEXT, post_status TEXT);
CREATE TABLE iuw_suppliers (id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT);
CREATE TABLE iuw_product_owners (wc_product_id INTEGER PRIMARY KEY, supplier_id TEXT, deleted_at TEXT);
CREATE TABLE wp_postmeta (meta_id INTEGER PRIMARY KEY, post_id INTEGER, meta_key TEXT, meta_value TEXT);
INSERT INTO iuw_suppliers VALUES ('a','active',NULL),('b','active',NULL),('paused','suspended',NULL);
INSERT INTO wp_posts VALUES (1,'product','publish'),(2,'product','publish'),(3,'product','publish'),(4,'product','draft'),(5,'product','publish'),(6,'product','publish'),(7,'product','publish');
INSERT INTO iuw_product_owners VALUES (1,'a',NULL),(2,'b',NULL),(3,'paused',NULL),(4,'a',NULL),(5,'a',NULL),(6,'a','2026-11-11');
INSERT INTO wp_postmeta (post_id,meta_key,meta_value) VALUES (1,'_manage_stock','yes'),(1,'_stock','5'),(1,'_stock_status','instock'),(5,'_stock_status','outofstock');`);
const { getPool } = await import("../dist/db/pool.js");
getPool().query = async (sql, params = {}) => [db.prepare(sql).all(params)];
const { listStockingSupplierIds } = await import("../dist/repositories/productRepo.js");
assert.deepEqual(await listStockingSupplierIds(1,5),['a']);
assert.deepEqual(await listStockingSupplierIds(1,6),[]);
assert.deepEqual(await listStockingSupplierIds(2,100),['b']);
for (const id of [3,4,5,6,7,999]) assert.deepEqual(await listStockingSupplierIds(id,1),[]);
db.exec("INSERT INTO wp_postmeta (post_id,meta_key,meta_value) VALUES (1,'_stock_status','outofstock')");
assert.deepEqual(await listStockingSupplierIds(1,1),[],"latest stock metadata wins");
db.close(); await getPool().end();
console.log("Stock routing SQL passed: exact ownership, quantity, current stock, active suppliers, published products and missing/deleted exclusions.");
