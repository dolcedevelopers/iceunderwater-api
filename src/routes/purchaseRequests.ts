import { refundPreviewFor, sendRefundRequestFor } from "../services/refundRequestService.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import { purchaseHistoryFor } from "../services/purchaseHistoryService.js";
import {
  cancelPurchaseRequestFor,
  acceptPurchaseRequestFor,
  createPurchaseRequestFor,
  getPurchaseRequestFor,
  listPurchaseRequestsFor,
  listPurchaseSuppliersFor,
  matchPurchaseSuppliersFor,
  resendPurchaseRequestFor,
  startCheckoutFor,
} from "../services/purchaseRequestService.js";

const locationSchema = z.object({
  address: z.string().trim().max(512), province: z.string().trim().min(1).max(80),
  city: z.string().trim().min(1).max(120), fulfilmentType: z.enum(["delivery", "pickup"]),
}).strict();

const createSchema = z
  .object({
    location: locationSchema,
    deliveryAt: z.string().datetime({ offset: true }),
    wcProductId: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().positive().optional(),
    productName: z.string().optional(),
    targetSupplierId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict();

const purchaseRequestRoutes: FastifyPluginAsync = async (app) => {
  app.post("/purchase-requests/suppliers/match", async (request) => {
    const principal = requireAuth(request);
    const body = z.object({ location: locationSchema,
      items: z.array(z.object({ wcProductId: z.number().int().positive(), qty: z.number().int().positive() }).strict()).min(1).max(100),
    }).strict().parse(request.body);
    return matchPurchaseSuppliersFor(principal, body);
  });
  app.get("/me/purchase-history", async (request) => purchaseHistoryFor(requireAuth(request)));
  app.get("/purchase-requests/suppliers", async (request) => listPurchaseSuppliersFor(requireAuth(request)));
  app.get("/purchase-requests", async (request) => listPurchaseRequestsFor(requireAuth(request)));

  app.post("/purchase-requests", async (request) => {
    const body = createSchema.parse(request.body);
    return createPurchaseRequestFor(requireAuth(request), body, request.ip);
  });

  app.get<{ Params: { id: string } }>("/purchase-requests/:id", async (request) =>
    getPurchaseRequestFor(requireAuth(request), request.params.id),
  );

  app.post<{ Params: { id: string } }>("/purchase-requests/:id/accept", async (request) =>
    acceptPurchaseRequestFor(requireAuth(request), request.params.id, request.ip),
  );

  app.get<{ Params: { id: string } }>("/purchase-requests/:id/refund-request", async (request) =>
    refundPreviewFor(requireAuth(request), request.params.id),
  );
  app.post<{ Params: { id: string } }>("/purchase-requests/:id/refund-request", async (request) => {
    const principal = requireAuth(request);
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).strict().parse(request.body);
    return sendRefundRequestFor(principal, request.params.id, body.reason);
  });

  app.post<{ Params: { id: string } }>("/purchase-requests/:id/cancel", async (request) =>
    cancelPurchaseRequestFor(requireAuth(request), request.params.id, request.ip),
  );

  app.post<{ Params: { id: string } }>("/purchase-requests/:id/checkout", async (request) =>
    startCheckoutFor(requireAuth(request), request.params.id),
  );

  app.post<{ Params: { id: string } }>("/purchase-requests/:id/resend", async (request) => {
    const body = z.object({
      location: locationSchema.optional(),
      deliveryAt: z.string().datetime({ offset: true }).optional(),
      qty: z.coerce.number().int().positive().optional(),
      targetSupplierId: z.string().trim().min(1).max(64).nullable().optional(),
    }).strict().parse(request.body ?? {});
    return resendPurchaseRequestFor(requireAuth(request), request.params.id, body, request.ip);
  });
};

export default purchaseRequestRoutes;
