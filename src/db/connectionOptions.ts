import type { ConnectionOptions } from "mysql2";

/**
 * Parse DATABASE_URL into mysql2 options.
 * Append `?ssl=true` (or set DATABASE_SSL=true) when the host requires TLS —
 * common for remote cPanel MySQL from Render.
 */
export function parseDatabaseUrl(url: string, forceSsl = false): ConnectionOptions {
  const parsed = new URL(url);
  const sslFlag =
    forceSsl ||
    parsed.searchParams.get("ssl") === "true" ||
    parsed.searchParams.get("sslmode") === "require";

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
    timezone: "Z",
    connectTimeout: 20_000,
    ...(sslFlag ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}
