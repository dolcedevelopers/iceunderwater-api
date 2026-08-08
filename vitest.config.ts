import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setupEnv.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test",
      WP_BASE_URL: "https://iceunderwater.co.za",
      WP_BRIDGE_SECRET: "test-bridge-secret-32chars!!",
      WC_CONSUMER_KEY: "ck_test",
      WC_CONSUMER_SECRET: "cs_test",
      JWT_ACCESS_SECRET: "test-access-secret-min-32-characters-long",
      JWT_REFRESH_SECRET: "test-refresh-secret-min-32-characters-long",
      WC_WEBHOOK_SECRET: "webhook-secret",
    },
  },
});
