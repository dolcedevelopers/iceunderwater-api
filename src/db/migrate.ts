import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { config } from "../config.js";
import { parseDatabaseUrl } from "./connectionOptions.js";
import { ensureLiveSchemaOnConnection } from "./ensureSchema.js";
import { ensureDeliverySchemaOnConnection } from "./featureSchema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../migrations");

function databaseKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "3306"}${parsed.pathname}`;
}

async function applyFileMigrations(conn: mysql.Connection): Promise<void> {
  await conn.query(`
      CREATE TABLE IF NOT EXISTS iuw_schema_migrations (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const [existing] = await conn.query<{ id: string }[] & mysql.RowDataPacket[]>(
      "SELECT id FROM iuw_schema_migrations WHERE id = ?",
      [id],
    );
    if (existing[0]) continue;

    if (id === "017_delivery_handover") {
      // Startup may already have repaired some columns, or an earlier ALTER
      // may have succeeded without the migration ledger being written.
      await ensureDeliverySchemaOnConnection(conn);
    } else {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      for (const statement of splitStatements(sql)) {
        await conn.query(statement);
      }
    }
    await conn.execute("INSERT IGNORE INTO iuw_schema_migrations (id) VALUES (?)", [id]);
    console.log(`Applied ${id}`);
  }
}

async function migrateUrl(url: string, label: string): Promise<void> {
  const conn = await mysql.createConnection(parseDatabaseUrl(url, config.DATABASE_SSL));
  try {
    await applyFileMigrations(conn);
    const repaired = await ensureLiveSchemaOnConnection(conn);
    if (repaired.length) {
      console.log(`Repaired missing schema on ${label}: ${repaired.join(", ")}`);
    } else {
      console.log(`Schema already complete on ${label}.`);
    }
  } finally {
    await conn.end();
  }
}

async function main() {
  const migrateUrlValue = config.DATABASE_MIGRATE_URL || config.DATABASE_URL;

  if (process.argv.includes("--down")) {
    const conn = await mysql.createConnection(parseDatabaseUrl(migrateUrlValue, config.DATABASE_SSL));
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS iuw_schema_migrations (
          id VARCHAR(128) NOT NULL PRIMARY KEY,
          applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      const [rows] = await conn.query<{ id: string }[] & mysql.RowDataPacket[]>(
        "SELECT id FROM iuw_schema_migrations ORDER BY id DESC LIMIT 1",
      );
      const latest = rows[0]?.id;
      if (!latest) {
        console.log("No migrations to revert.");
        return;
      }
      const downFile = path.join(migrationsDir, `${latest}.down.sql`);
      const sql = await readFile(downFile, "utf8");
      for (const statement of splitStatements(sql)) {
        await conn.query(statement);
      }
      await conn.execute("DELETE FROM iuw_schema_migrations WHERE id = ?", [latest]);
      console.log(`Reverted ${latest}`);
    } finally {
      await conn.end();
    }
    return;
  }

  await migrateUrl(migrateUrlValue, "migrate database");
  if (config.DATABASE_MIGRATE_URL && databaseKey(config.DATABASE_MIGRATE_URL) !== databaseKey(config.DATABASE_URL)) {
    console.warn("DATABASE_MIGRATE_URL is not the app database; applying schema to DATABASE_URL as well.");
    await migrateUrl(config.DATABASE_URL, "app database");
  }
  console.log("Migrations complete.");
}

/**
 * Comment lines are stripped per statement rather than per chunk: a file that
 * opens with a `--` header would otherwise have its first statement discarded.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
