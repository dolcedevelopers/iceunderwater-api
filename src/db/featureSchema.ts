import type { Connection, PoolConnection } from "mysql2/promise";
import { query } from "./pool.js";

type SchemaConn = Connection | PoolConnection;
export const deliveryColumns = {
  accepted_at: "DATETIME(3) NULL",
  arrived_at: "DATETIME(3) NULL",
  collect_by: "DATETIME(3) NULL",
  recipient_name: "VARCHAR(160) NULL",
  receipt_wp_user_id: "BIGINT UNSIGNED NULL",
  failure_reason: "VARCHAR(512) NULL",
  redelivery_reason: "VARCHAR(512) NULL",
  requested_at: "DATETIME(3) NULL",
  attempt_number: "INT UNSIGNED NOT NULL DEFAULT 1",
} as const;

export async function ensureDeliverySchemaOnConnection(conn: SchemaConn): Promise<string[]> {
  const applied: string[] = [];
  for (const [table, columns] of [["iuw_deliveries", deliveryColumns], ["iuw_delivery_events", { details: "TEXT NULL" }]] as const) {
    for (const [column, definition] of Object.entries(columns)) {
      const [rows] = await conn.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column]);
      if ((rows as unknown[]).length) continue;
      try {
        await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        applied.push(`${table}.${column}`);
      } catch (error) {
        // Overlapping Render deployments may both discover the missing column.
        if ((error as { code?: string }).code !== "ER_DUP_FIELDNAME") throw error;
      }
    }
  }
  const [indexes] = await conn.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='iuw_deliveries' AND INDEX_NAME='idx_iuw_delivery_deadline'");
  if (!(indexes as unknown[]).length) {
    try {
      await conn.query("ALTER TABLE iuw_deliveries ADD KEY idx_iuw_delivery_deadline (status,collect_by)");
      applied.push("iuw_deliveries.idx_iuw_delivery_deadline");
    } catch (error) {
      if ((error as { code?: string }).code !== "ER_DUP_KEYNAME") throw error;
    }
  }
  return applied;
}

export async function ensureRsvpSchemaOnConnection(conn: SchemaConn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS iuw_event_rsvps (
    id VARCHAR(64) NOT NULL PRIMARY KEY, event_key VARCHAR(80) NOT NULL,
    wp_user_id BIGINT UNSIGNED NOT NULL, email VARCHAR(254) NOT NULL,
    province VARCHAR(80) NOT NULL, city VARCHAR(120) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'confirmed',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_iuw_rsvp_attendee (event_key,wp_user_id),
    KEY idx_iuw_rsvp_summary (event_key,status,province,city)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

const probes = [
  `SELECT ${Object.keys(deliveryColumns).join(",")} FROM iuw_deliveries LIMIT 0`,
  "SELECT details FROM iuw_delivery_events LIMIT 0",
  "SELECT id,event_key,wp_user_id,email,province,city,status,created_at,updated_at FROM iuw_event_rsvps LIMIT 0",
];

/** Fail startup before starting the worker if the runtime database is incomplete. */
export async function assertFeatureSchemaOnConnection(conn: SchemaConn) {
  for (const sql of probes) await conn.query(sql);
}

export async function featureSchemaReady(): Promise<boolean> {
  try {
    for (const sql of probes) await query(sql);
    return true;
  } catch { return false; }
}
