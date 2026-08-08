import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATE_URL: z.string().min(1).optional(),
  /** Enable TLS for remote MySQL (cPanel → Render). Also accepted as ?ssl=true on the URL. */
  DATABASE_SSL: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  WP_BASE_URL: z.string().url(),
  WP_BRIDGE_SECRET: z.string().min(16),
  WP_BRIDGE_ALLOWED_IPS: z.string().default(""),
  WC_CONSUMER_KEY: z.string().min(1),
  WC_CONSUMER_SECRET: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  CORS_ORIGINS: z.string().default(""),
  WC_WEBHOOK_SECRET: z.string().min(8),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  DRIVER_PING_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
});

export type AppConfig = z.infer<typeof envSchema> & {
  corsOrigins: string[];
  bridgeAllowedIps: string[];
};

function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  const data = parsed.data;
  return {
    ...data,
    DATABASE_SSL: Boolean(data.DATABASE_SSL),
    corsOrigins: data.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    bridgeAllowedIps: data.WP_BRIDGE_ALLOWED_IPS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const config = loadConfig();
