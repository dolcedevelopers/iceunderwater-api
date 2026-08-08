import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { config } from "../config.js";
import { parseDatabaseUrl } from "./connectionOptions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../migrations");

async function main() {
  const down = process.argv.includes("--down");
  const url = config.DATABASE_MIGRATE_URL || config.DATABASE_URL;
  const conn = await mysql.createConnection(parseDatabaseUrl(url, config.DATABASE_SSL));

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS iuw_schema_migrations (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    if (down) {
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
      return;
    }

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

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      for (const statement of splitStatements(sql)) {
        await conn.query(statement);
      }
      await conn.execute("INSERT INTO iuw_schema_migrations (id) VALUES (?)", [id]);
      console.log(`Applied ${id}`);
    }
    console.log("Migrations complete.");
  } finally {
    await conn.end();
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
