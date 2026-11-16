import type { FastifyPluginAsync } from "fastify";
import {
  getPublicProduct,
  listCatalogueCategories,
  listPublicProducts,
} from "../services/productService.js";
import { notFound } from "../lib/errors.js";

const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get("/catalogue/products", async (request) => listPublicProducts(request.principal));

  app.get<{ Params: { id: string } }>("/catalogue/products/:id", async (request) => {
    const product = await getPublicProduct(request.params.id, request.principal);
    if (!product) throw notFound("Product not found.");
    return product;
  });

  app.get("/catalogue/categories", async (request) => listCatalogueCategories(request.principal));
};

export default catalogueRoutes;
