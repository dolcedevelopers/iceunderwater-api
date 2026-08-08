import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { accessDenied, validationError } from "../lib/errors.js";
import { syncWooOrder } from "../services/transactionService.js";

function verifyWooSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const digest = createHmac("sha256", config.WC_WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isWooPing(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== "object") return false;
  // Woo save/test ping is typically: { "webhook_id": 123 }
  if ("webhook_id" in payload && !("line_items" in payload) && payload.status === undefined) {
    return !("id" in payload) || Object.keys(payload).length <= 2;
  }
  return false;
}

/**
 * Encapsulated so we can accept whatever Content-Type WooCommerce sends
 * without breaking the rest of the API.
 */
const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    // Do not trim — Woo signs the exact raw bytes.
    const text = body.toString("utf8");
    if (!text) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.post("/webhooks/woocommerce/orders", async (request, reply) => {
    const signature = request.headers["x-wc-webhook-signature"];
    const topicHeader = request.headers["x-wc-webhook-topic"];
    const topic = Array.isArray(topicHeader) ? topicHeader[0] : topicHeader;
    const raw = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});

    request.log.info(
      {
        topic,
        contentType: request.headers["content-type"],
        bodyKeys: request.body && typeof request.body === "object" ? Object.keys(request.body as object) : [],
      },
      "woo webhook received",
    );

    if (!verifyWooSignature(raw, Array.isArray(signature) ? signature[0] : signature)) {
      throw accessDenied("Invalid webhook signature.");
    }

    const payload = (
      typeof request.body === "string" ? JSON.parse(request.body) : request.body
    ) as Record<string, unknown> | null;

    if (isWooPing(payload)) {
      return reply.code(200).send({ received: true, ping: true });
    }

    const orderId = payload && "id" in payload ? Number(payload.id) : NaN;
    if (!payload || !Number.isFinite(orderId)) {
      throw validationError("Invalid order payload.");
    }

    try {
      const result = await syncWooOrder(payload as Parameters<typeof syncWooOrder>[0]);
      return reply.code(200).send(result);
    } catch (error) {
      request.log.error({ err: error, orderId, topic }, "woo webhook sync failed");
      throw error;
    }
  });
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export default webhookRoutes;
