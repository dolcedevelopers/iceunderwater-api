import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { requireAuth } from "../plugins/auth.js";
import {
  getTransactionFor,
  listMyReceipts,
  listTransactionsFor,
  sendReceiptFor,
  syncWooOrder,
  updateTransactionFor,
} from "../services/transactionService.js";
import { accessDenied, validationError } from "../lib/errors.js";

const patchSchema = z
  .object({
    status: z.enum(["paid", "pending", "refunded", "failed"]),
  })
  .strict();

function verifyWooSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const digest = createHmac("sha256", config.WC_WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { supplierId?: string; reference?: string } }>("/transactions", async (request) =>
    listTransactionsFor(requireAuth(request), {
      supplierId: request.query.supplierId,
      reference: request.query.reference,
    }),
  );

  app.get<{ Params: { id: string } }>("/transactions/:id", async (request) =>
    getTransactionFor(requireAuth(request), request.params.id),
  );

  app.patch<{ Params: { id: string } }>("/transactions/:id", async (request) => {
    const body = patchSchema.parse(request.body);
    return updateTransactionFor(requireAuth(request), request.params.id, body, request.ip);
  });

  app.post<{ Params: { id: string } }>("/transactions/:id/receipt", async (request) =>
    sendReceiptFor(requireAuth(request), request.params.id, request.ip),
  );

  app.get("/me/receipts", async (request) => listMyReceipts(requireAuth(request)));

  app.post("/webhooks/woocommerce/orders", { config: { rawBody: true } }, async (request) => {
    const signature = request.headers["x-wc-webhook-signature"];
    const raw =
      typeof request.body === "string"
        ? request.body
        : Buffer.isBuffer(request.rawBody)
          ? request.rawBody.toString("utf8")
          : JSON.stringify(request.body);

    if (!verifyWooSignature(raw, Array.isArray(signature) ? signature[0] : signature)) {
      throw accessDenied("Invalid webhook signature.");
    }

    const order = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    if (!order || typeof order !== "object" || !("id" in (order as object))) {
      throw validationError("Invalid order payload.");
    }
    return syncWooOrder(order as Parameters<typeof syncWooOrder>[0]);
  });
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export default transactionRoutes;
