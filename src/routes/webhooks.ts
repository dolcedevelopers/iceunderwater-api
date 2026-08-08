import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { accessDenied, validationError } from "../lib/errors.js";
import { syncWooOrder } from "../services/transactionService.js";

function signaturesMatch(rawBody: string, secret: string, signature: string): boolean {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Woo signs the payload it *intends* to send (usually JSON).
 * Some hosts rewrite the ping to `webhook_id=1`, which breaks a naive check.
 */
function verifyWooSignature(
  rawBody: string,
  signature: string | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!signature) return false;
  const secret = config.WC_WEBHOOK_SECRET;
  const candidates = new Set<string>([rawBody]);

  if ("webhook_id" in payload) {
    const id = payload.webhook_id;
    candidates.add(JSON.stringify({ webhook_id: id }));
    candidates.add(JSON.stringify({ webhook_id: Number(id) }));
    candidates.add(`webhook_id=${id}`);
  }

  for (const candidate of candidates) {
    if (signaturesMatch(candidate, secret, signature)) return true;
  }
  return false;
}

/** Woo save/test ping is often `webhook_id=1` (form) or `{ "webhook_id": 1 }` (JSON). */
function parseWooBody(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};

  if (text.startsWith("{") || text.startsWith("[")) {
    return JSON.parse(text) as Record<string, unknown>;
  }

  const params = new URLSearchParams(text);
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    const asNumber = Number(value);
    out[key] = Number.isFinite(asNumber) && String(asNumber) === value ? asNumber : value;
  }
  return out;
}

function isWooPing(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== "object") return false;
  if ("webhook_id" in payload && !("line_items" in payload) && payload.status === undefined) {
    return !("id" in payload) || Object.keys(payload).length <= 2;
  }
  return false;
}

const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try {
      done(null, parseWooBody(body.toString("utf8")));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.post("/webhooks/woocommerce/orders", async (request, reply) => {
    const signatureHeader = request.headers["x-wc-webhook-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const topicHeader = request.headers["x-wc-webhook-topic"];
    const topic = Array.isArray(topicHeader) ? topicHeader[0] : topicHeader;
    const raw = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});

    const payload = (request.body || {}) as Record<string, unknown>;
    const ping = isWooPing(payload);

    request.log.info(
      {
        topic,
        contentType: request.headers["content-type"],
        bodyKeys: Object.keys(payload),
        hasSignature: Boolean(signature),
        ping,
      },
      "woo webhook received",
    );

    const signedOk = verifyWooSignature(raw, signature, payload);

    // Pings carry no order data. Hosts often rewrite the body and break HMAC;
    // acknowledge them so Woo marks the webhook active. Real orders still require a valid signature.
    if (ping) {
      if (!signedOk) {
        request.log.warn("woo ping accepted without matching signature (body may have been rewritten in transit)");
      }
      return reply.code(200).send({ received: true, ping: true });
    }

    if (!signedOk) {
      throw accessDenied("Invalid webhook signature.");
    }

    const orderId = "id" in payload ? Number(payload.id) : NaN;
    if (!Number.isFinite(orderId)) {
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
