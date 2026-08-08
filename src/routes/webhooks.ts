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
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Encapsulated so we can accept whatever Content-Type WooCommerce sends
 * (missing, charset variants, text/plain) without breaking the rest of the API.
 */
const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    const text = body.toString("utf8").trim();
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
    const topic = request.headers["x-wc-webhook-topic"];
    const raw = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});

    if (!verifyWooSignature(raw, Array.isArray(signature) ? signature[0] : signature)) {
      throw accessDenied("Invalid webhook signature.");
    }

    const payload = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) as Record<
      string,
      unknown
    > | null;

    // Woo sends a ping when the webhook is saved — acknowledge without syncing.
    const topicValue = Array.isArray(topic) ? topic[0] : topic;
    if (topicValue === "action.woocommerce_webhook_ping" || (payload && "webhook_id" in payload && !("id" in payload))) {
      return reply.code(200).send({ received: true, ping: true });
    }

    if (!payload || typeof payload !== "object" || typeof payload.id !== "number") {
      throw validationError("Invalid order payload.");
    }

    const result = await syncWooOrder(payload as Parameters<typeof syncWooOrder>[0]);
    return reply.code(200).send(result);
  });
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export default webhookRoutes;
