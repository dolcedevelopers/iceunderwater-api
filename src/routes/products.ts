import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  createProductFor,
  listProductCategoriesFor, createProductCategoryFor, uploadProductPhotoFor,
  deleteProductFor,
  listManagedProducts,
  updateProductFor,
  uploadProductImage,
} from "../services/productService.js";
import { readImageFromRequest } from "../lib/uploadRequest.js";

const photosSchema=z.array(z.object({id:z.number().int().positive().optional(),src:z.string().url().optional()}).strict().refine(photo=>Boolean(photo.id||photo.src),"Choose a valid photo.")).max(5,"A product can have a maximum of 5 photos.");

const createSchema = z
  .object({
    supplierId: z.string().optional(),
    name: z.string().min(1),
    category: z.string().optional(),
    images: photosSchema.optional(),
    /** Supplier cost / loaded price. Prefer this over price. */
    costPrice: z.number().optional(),
    /** Back-compat: treated as cost when costPrice omitted. */
    price: z.number().optional(),
    stock: z.number().int().optional(),
    unit: z.string().trim().max(80).optional(),
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
    images: photosSchema.optional(),
    costPrice: z.number().optional(),
    price: z.number().optional(),
    stock: z.number().int().optional(),
    unit: z.string().trim().max(80).optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    image: z.string().optional(),
  })
  .strict();

const productRoutes: FastifyPluginAsync = async (app) => {
  app.get("/product-categories",async request=>listProductCategoriesFor(requireAuth(request)));
  app.post("/product-categories",{config:{rateLimit:{max:10,timeWindow:"1 minute"}}},async request=>createProductCategoryFor(requireAuth(request),z.object({name:z.string().trim().min(1).max(100)}).strict().parse(request.body).name));
  app.post<{Querystring:{supplierId?:string}}>("/products/photos",async request=>{const principal=requireAuth(request);const {buffer,filename}=await readImageFromRequest(request);return uploadProductPhotoFor(principal,buffer,filename,request.query.supplierId);});
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
