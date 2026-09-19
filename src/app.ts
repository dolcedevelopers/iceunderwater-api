import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "./config.js";
import authPlugin from "./plugins/auth.js";
import errorHandler from "./plugins/errorHandler.js";
import authRoutes from "./routes/auth.js";
import catalogueRoutes from "./routes/catalogue.js";
import supplierRoutes from "./routes/suppliers.js";
import productRoutes from "./routes/products.js";
import driverRoutes from "./routes/drivers.js";
import adminRoutes from "./routes/admin.js";
import transactionRoutes from "./routes/transactions.js";
import webhookRoutes from "./routes/webhooks.js";
import eventGroupRoutes from "./routes/eventGroups.js";
import locationRoutes from "./routes/locations.js";
import purchaseRequestRoutes from "./routes/purchaseRequests.js";
import notificationRoutes from "./routes/notifications.js";
import { pingDb } from "./db/pool.js";
import { pingWooCommerce } from "./clients/woocommerce.js";
import { pingWordpress } from "./clients/wordpress.js";

export async function buildApp() {
  const app = Fastify({
    // Render (and most hosts) terminate TLS upstream — needed for correct client IPs.
    trustProxy: true,
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "body.password", "body.refreshToken", "body.token"],
    },
    requestIdHeader: "x-request-id",
    bodyLimit: 8_388_608,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try {
      const json = body.length ? JSON.parse(body.toString("utf8")) : {};
      done(null, json);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  await app.register(errorHandler);
  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  });
  await app.register(multipart, {
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1 },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "ICE UNDERWATER API",
        description: "Supplier, driver and admin API sharing the WordPress/WooCommerce database.",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(authPlugin);

  /** Liveness for Render — always 200 once the process is up. */
  app.get("/live", async () => ({ status: "ok", time: new Date().toISOString() }));

  /** Deep health — DB + WordPress + Woo. Used for ops, not the platform probe. */
  app.get("/health", async () => {
    const [db, wp, woo] = await Promise.all([pingDb(), pingWordpress(), pingWooCommerce()]);
    const ok = db && wp;
    return {
      status: ok ? "ok" : "degraded",
      db,
      wordpress: wp,
      woocommerce: woo,
      time: new Date().toISOString(),
    };
  });

  await app.register(authRoutes);
  await app.register(catalogueRoutes);
  await app.register(supplierRoutes);
  await app.register(productRoutes);
  await app.register(driverRoutes);
  await app.register(adminRoutes);
  await app.register(transactionRoutes);
  await app.register(webhookRoutes);
  await app.register(eventGroupRoutes);
  await app.register(locationRoutes);
  await app.register(purchaseRequestRoutes);
  await app.register(notificationRoutes);

  return app;
}
