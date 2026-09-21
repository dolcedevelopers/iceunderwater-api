import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  acceptPurchaseRequestFor,
  createPurchaseRequestFor,
  getPurchaseRequestFor,
  listPurchaseRequestsFor,
  resendPurchaseRequestFor,
  startCheckoutFor,
} from "../services/purchaseRequestService.js";

const createSchema = z
  .object({
    wcProductId: z.coerce.number().int().positive(),
    qty: z.coerce.number().int().positive().optional(),
    productName: z.string().optional(),
  })
  .strict();

const purchaseRequestRoutes: FastifyPluginAsync = async (app) => {
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

  app.post<{ Params: { id: string } }>("/purchase-requests/:id/checkout", async (request) =>
    startCheckoutFor(requireAuth(request), request.params.id),
  );

  app.post<{ Params: { id: string } }>("/purchase-requests/:id/resend", async (request) => {
    const body = z.object({ qty: z.coerce.number().int().positive().optional() }).strict().parse(request.body ?? {});
    return resendPurchaseRequestFor(requireAuth(request), request.params.id, body, request.ip);
  });
};

export default purchaseRequestRoutes;
