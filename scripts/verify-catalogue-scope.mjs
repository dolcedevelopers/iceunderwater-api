// Optional Node 22+ SQL fixture check. Run npm run build first.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test", WP_BASE_URL: "https://iceunderwater.co.za",
  WP_BRIDGE_SECRET: "test-bridge-secret-32chars!!", WC_CONSUMER_KEY: "ck_test", WC_CONSUMER_SECRET: "cs_test",
  JWT_ACCESS_SECRET: "test-access-secret-min-32-characters-long", JWT_REFRESH_SECRET: "test-refresh-secret-min-32-characters-long", WC_WEBHOOK_SECRET: "webhook-secret",
});
const db = new DatabaseSync(":memory:");
db.function("CONCAT", { varargs: true }, (...parts) => parts.join(""));
db.exec(`CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_type TEXT, post_status TEXT, post_title TEXT, post_excerpt TEXT, post_content TEXT, guid TEXT);
  CREATE TABLE iuw_product_owners (wc_product_id INTEGER PRIMARY KEY, supplier_id TEXT, deleted_at TEXT);
  CREATE TABLE iuw_suppliers (id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT, markup_percent INTEGER);
  CREATE TABLE wp_postmeta (post_id INTEGER, meta_key TEXT, meta_value TEXT);
  CREATE TABLE wp_options (option_name TEXT, option_value TEXT);
  CREATE TABLE wp_terms (term_id INTEGER, name TEXT, slug TEXT);
  CREATE TABLE wp_term_taxonomy (term_taxonomy_id INTEGER, term_id INTEGER, taxonomy TEXT);
  CREATE TABLE wp_term_relationships (object_id INTEGER, term_taxonomy_id INTEGER);
  INSERT INTO iuw_suppliers VALUES ('a','active',NULL,8),('b','suspended',NULL,0);
  INSERT INTO wp_options VALUES ('siteurl','https://iceunderwater.co.za');
  INSERT INTO wp_terms VALUES (1,'Hidden','exclude-from-catalog'),(2,'Variable','variable'),(3,'Water','water');
  INSERT INTO wp_term_taxonomy VALUES (1,1,'product_visibility'),(2,2,'product_type'),(3,3,'product_cat');
  INSERT INTO wp_term_relationships VALUES (7,1),(9,2),(1,3),(2,3);
  INSERT INTO iuw_product_owners VALUES (2,'a',NULL),(3,'b',NULL),(4,'a','2026-11-07'),(5,'a',NULL),(8,'a',NULL);`);
const post = db.prepare("INSERT INTO wp_posts VALUES (?, 'product', ?, ?, '', 'Description', '')");
for (let id = 1; id <= 9; id++) post.run(id, id === 5 ? "draft" : id === 6 ? "private" : "publish", `Product ${id}`);
db.exec(`INSERT INTO wp_postmeta VALUES (1,'_price','239.95'),(2,'_price','14.04'),(8,'_price','25'),(8,'_stock_status','outofstock'),(9,'_price','30');`);
const { getPool } = await import("../dist/db/pool.js");
getPool().query = async (sql, params = {}) => {
  // Only translate MySQL's TRIM grammar; the actual joins, filters, cases and grouping run unchanged.
  const sqliteSql = sql.replace("TRIM(TRAILING '/' FROM REPLACE(COALESCE(site.option_value, ''), 'http://', 'https://'))",
    "RTRIM(REPLACE(COALESCE(site.option_value, ''), 'http://', 'https://'), '/')");
  return [db.prepare(sqliteSql).all(Object.fromEntries(Object.entries(params).filter(([key]) => sqliteSql.includes(`:${key}`))))];
};
const { listProductsFromWp } = await import("../dist/repositories/productRepo.js");
const products = await listProductsFromWp({ publicOnly: true });
assert.deepEqual(products.map((row) => row.id), [1,2,8,9]);
assert.equal(products.find((row) => row.id === 1).supplier_id, "");
assert.equal(products.find((row) => row.id === 1).price_cents, 23995);
assert.equal(products.find((row) => row.id === 8).in_stock, 0);
assert.equal(products.find((row) => row.id === 9).has_options, 1);
assert.deepEqual((await listProductsFromWp({ supplierId: "a" })).map((row) => row.id), [2,5,8]);
db.close(); await getPool().end();
console.log("Catalogue SQL verified: WordPress/mobile products, correct prices, stock/options, and hidden/deleted/private/suspended exclusions.");
