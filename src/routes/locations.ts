import type { FastifyPluginAsync } from "fastify";
import { locationsPayload } from "../data/saLocations.js";

const locationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/locations", async () => locationsPayload());
};

export default locationRoutes;
