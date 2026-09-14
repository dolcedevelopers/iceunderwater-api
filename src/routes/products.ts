import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  createProductFor,
  deleteProductFor,
  listManagedProducts,
  updateProductFor,
  uploadProductImage,
} from "../services/productService.js";
import { readImageFromRequest } from "../lib/uploadRequest.js";

const createSchema = z
  .object({
    supplierId: z.string().optional(),
    name: z.string().min(1),
    category: z.string().optional(),
    /** Supplier cost / loaded price. Prefer this over price. */
    costPrice: z.number().optional(),
    /** Back-compat: treated as cost when costPrice omitted. */
    price: z.number().optional(),
    stock: z.number().int().optional(),
    unit: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.costPrice != null || b.price != null, {
    message: "costPrice or price is required",
    path: ["costPrice"],
  });

const patchSchema = z
  .object({
    name: z.string().optional(),
    category: z.string().optional(),
    costPrice: z.number().optional(),
    price: z.number().optional(),
    stock: z.number().int().optional(),
    unit: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    image: z.string().optional(),
  })
  .strict();

const productRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { supplierId?: string } }>("/products", async (request) =>
    listManagedProducts(requireAuth(request), request.query.supplierId),
  );

  app.post("/products", async (request) => {
    const body = createSchema.parse(request.body);
    return createProductFor(requireAuth(request), body.supplierId, body, request.ip);
  });

  app.patch<{ Params: { id: string } }>("/products/:id", async (request) => {
    const body = patchSchema.parse(request.body);
    return updateProductFor(requireAuth(request), request.params.id, body, request.ip);
  });

  app.delete<{ Params: { id: string } }>("/products/:id", async (request) =>
    deleteProductFor(requireAuth(request), request.params.id, request.ip),
  );

  app.post<{ Params: { id: string } }>("/products/:id/image", async (request) => {
    const principal = requireAuth(request);
    const { buffer, filename } = await readImageFromRequest(request);
    return uploadProductImage(principal, request.params.id, buffer, filename, request.ip);
  });
};

export default productRoutes;
