import type { FastifyPluginAsync } from "fastify";
import {
  getPublicProduct,
  listCatalogueCategories,
  listPublicProducts,
} from "../services/productService.js";
import { notFound } from "../lib/errors.js";

const catalogueRoutes: FastifyPluginAsync = async (app) => {
  app.get("/catalogue/products", async () => listPublicProducts());

  app.get<{ Params: { id: string } }>("/catalogue/products/:id", async (request) => {
    const product = await getPublicProduct(request.params.id);
    if (!product) throw notFound("Product not found.");
    return product;
  });

  app.get("/catalogue/categories", async () => listCatalogueCategories());
};

export default catalogueRoutes;
