import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  createSupplierFor,
  deleteSupplierFor,
  getSupplierBrand,
  getSupplierFor,
  listSuppliersFor,
  supplierOverview,
  supplierSettlementReport,
  updateSupplierFor,
  uploadSupplierLogo,
} from "../services/supplierService.js";
import { notFound, validationError } from "../lib/errors.js";

const createSchema = z
  .object({
    name: z.string().min(1),
    contactName: z.string().optional(),
    email: z.string().email(),
    phone: z.string().optional(),
    city: z.string().optional(),
    password: z.string().min(8).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().optional(),
    contactName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    logo: z.string().optional(),
    status: z.enum(["active", "pending", "suspended"]).optional(),
  })
  .strict();

const supplierRoutes: FastifyPluginAsync = async (app) => {
  app.get("/suppliers", async (request) => listSuppliersFor(requireAuth(request)));

  app.post("/suppliers", async (request) => {
    const body = createSchema.parse(request.body);
    return createSupplierFor(requireAuth(request), body, request.ip);
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id/brand", async (request) => {
    const brand = await getSupplierBrand(request.params.id);
    if (!brand) throw notFound("Brand not found.");
    return brand;
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id", async (request) =>
    getSupplierFor(requireAuth(request), request.params.id),
  );

  app.patch<{ Params: { id: string } }>("/suppliers/:id", async (request) => {
    const body = patchSchema.parse(request.body);
    return updateSupplierFor(requireAuth(request), request.params.id, body, request.ip);
  });

  app.delete<{ Params: { id: string } }>("/suppliers/:id", async (request) =>
    deleteSupplierFor(requireAuth(request), request.params.id, request.ip),
  );

  app.post<{ Params: { id: string } }>("/suppliers/:id/logo", async (request) => {
    const principal = requireAuth(request);
    const file = await request.file();
    if (!file) throw validationError("Image file is required.");
    const buffer = await file.toBuffer();
    return uploadSupplierLogo(principal, request.params.id, buffer, file.filename, request.ip);
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id/overview", async (request) =>
    supplierOverview(requireAuth(request), request.params.id),
  );

  app.get<{ Params: { id: string } }>("/suppliers/:id/settlement", async (request) =>
    supplierSettlementReport(requireAuth(request), request.params.id),
  );
};

export default supplierRoutes;
