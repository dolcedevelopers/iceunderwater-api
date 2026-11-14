import { invoicePdfFor } from "../services/invoicePdfService.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  getTransactionFor,
  listMyReceipts,
  listTransactionsFor,
  sendReceiptFor,
  updateTransactionFor,
} from "../services/transactionService.js";

const patchSchema = z
  .object({
    status: z.enum(["paid", "pending", "refunded", "failed"]),
  })
  .strict();

const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.get<{Params:{id:string}}>("/invoices/:id/pdf",request=>invoicePdfFor(requireAuth(request),request.params.id));
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

  /** Alias — same ACL as transactions/receipts, clearer for app invoices UI. */
  app.get("/invoices", async (request) => listMyReceipts(requireAuth(request)));
  app.get<{ Params: { id: string } }>("/invoices/:id", async (request) =>
    getTransactionFor(requireAuth(request), request.params.id),
  );
};

export default transactionRoutes;
