import type { Connection, PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "./pool.js";

type CountRow = RowDataPacket & { n: number };
type SchemaConn = Connection | PoolConnection;

async function countOn(conn: SchemaConn, sql: string, params: Record<string, string>): Promise<number> {
  const [rows] = (await conn.query(sql, params as never)) as [CountRow[], unknown];
  return Number(rows[0]?.n) || 0;
}

async function columnExists(conn: SchemaConn, tableName: string, columnName: string): Promise<boolean> {
  return (
    (await countOn(
      conn,
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tableName AND COLUMN_NAME = :columnName`,
      { tableName, columnName },
    )) > 0
  );
}

async function indexExists(conn: SchemaConn, tableName: string, indexName: string): Promise<boolean> {
  return (
    (await countOn(
      conn,
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tableName AND INDEX_NAME = :indexName`,
      { tableName, indexName },
    )) > 0
  );
}

async function addColumn(
  conn: SchemaConn,
  tableName: string,
  columnName: string,
  definition: string,
  applied: string[],
): Promise<void> {
  if (await columnExists(conn, tableName, columnName)) return;
  await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  applied.push(`${tableName}.${columnName}`);
}

async function addIndex(
  conn: SchemaConn,
  tableName: string,
  indexName: string,
  columns: string,
  applied: string[],
): Promise<void> {
  if (await indexExists(conn, tableName, indexName)) return;
  await conn.query(`ALTER TABLE ${tableName} ADD KEY ${indexName} (${columns})`);
  applied.push(`${tableName}.${indexName}`);
}

/**
 * 008 was recorded on some environments without its ALTER TABLEs actually
 * landing on the database the API queries. This reapplies those columns
 * and indexes only when they are missing, so a deploy self-heals.
 */
export async function ensureLiveSchemaOnConnection(conn: SchemaConn): Promise<string[]> {
  const applied: string[] = [];
  await addColumn(conn, "iuw_purchase_requests", "refund_status", "VARCHAR(16) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "refund_reason", "TEXT NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "refund_requested_at", "DATETIME(3) NULL", applied);

  await addColumn(conn, "iuw_suppliers", "latitude", "DECIMAL(10,7) NULL", applied);
  await addColumn(conn, "iuw_suppliers", "longitude", "DECIMAL(10,7) NULL", applied);
  await addColumn(conn, "iuw_suppliers", "service_radius_km", "DECIMAL(7,2) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "fulfilment_type", "VARCHAR(16) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "location_province", "VARCHAR(80) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "location_city", "VARCHAR(120) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "location_address", "VARCHAR(512) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "location_latitude", "DECIMAL(10,7) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "location_longitude", "DECIMAL(10,7) NULL", applied);

  await addColumn(conn, "iuw_suppliers", "vat_number", "VARCHAR(64) NOT NULL DEFAULT ''", applied);
  await addColumn(conn, "iuw_suppliers", "registration_number", "VARCHAR(64) NOT NULL DEFAULT ''", applied);
  await addColumn(conn, "iuw_suppliers", "address", "VARCHAR(512) NOT NULL DEFAULT ''", applied);

  await addColumn(conn, "iuw_purchase_requests", "requester_supplier_id", "VARCHAR(64) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "target_supplier_id", "VARCHAR(64) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "delivery_at", "DATETIME(3) NULL", applied);
  await addColumn(conn, "iuw_purchase_requests", "expires_at", "DATETIME(3) NULL", applied);
  await addColumn(
    conn,
    "iuw_purchase_requests",
    "resend_count",
    "INT UNSIGNED NOT NULL DEFAULT 0",
    applied,
  );
  await addIndex(
    conn,
    "iuw_purchase_requests",
    "idx_iuw_pr_requester",
    "requester_supplier_id, status",
    applied,
  );
  await addIndex(conn, "iuw_purchase_requests", "idx_iuw_pr_expiry", "status, expires_at", applied);

  if (await columnExists(conn, "iuw_purchase_requests", "expires_at")) {
    await conn.query(
      `UPDATE iuw_purchase_requests
          SET expires_at = DATE_ADD(created_at, INTERVAL 15 MINUTE)
        WHERE expires_at IS NULL AND status = 'open'`,
    );
  }

  return applied;
}

export async function ensureLiveSchema(): Promise<string[]> {
  const conn = await getPool().getConnection();
  try {
    return await ensureLiveSchemaOnConnection(conn);
  } finally {
    conn.release();
  }
}
