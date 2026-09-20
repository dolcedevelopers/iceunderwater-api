import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  assignDelivery,
  createDriverFor,
  deleteDriverFor,
  listDeliveriesFor,
  listDriversFor,
  patchDelivery,
  postDriverPing,
  trackDriver,
  updateDriverFor,
} from "../services/driverService.js";

const createSchema = z
  .object({
    supplierId: z.string().optional(),
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional().or(z.literal("")),
    vehicle: z.string().optional(),
    registration: z.string().optional(),
    licence: z.string().optional(),
    status: z.enum(["available", "on-delivery", "off-duty"]).optional(),
    active: z.boolean().optional(),
    password: z.string().min(8).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    vehicle: z.string().optional(),
    registration: z.string().optional(),
    licence: z.string().optional(),
    status: z.enum(["available", "on-delivery", "off-duty"]).optional(),
    active: z.boolean().optional(),
    password: z.string().min(8).optional(),
  })
  .strict();

const pingSchema = z
  .object({
    lat: z.number(),
    lng: z.number(),
    accuracy: z.number().optional(),
    heading: z.number().optional(),
    speed: z.number().optional(),
  })
  .strict();

const deliveryCreateSchema = z
  .object({
    driverId: z.string().min(1),
    orderId: z.number().int().positive(),
    customerEmail: z.string().email().optional(),
    customerWpUserId: z.number().int().optional(),
  })
  .strict();

const deliveryPatchSchema = z.object({ status: z.string().min(1) }).strict();

const driverRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { supplierId?: string } }>("/drivers", async (request) =>
    listDriversFor(requireAuth(request), request.query.supplierId),
  );

  app.post("/drivers", async (request) => {
    const body = createSchema.parse(request.body);
    return createDriverFor(requireAuth(request), body.supplierId, body, request.ip);
  });

  app.patch<{ Params: { id: string } }>("/drivers/:id", async (request) => {
    const body = patchSchema.parse(request.body);
    return updateDriverFor(requireAuth(request), request.params.id, body, request.ip);
  });

  app.delete<{ Params: { id: string } }>("/drivers/:id", async (request) =>
    deleteDriverFor(requireAuth(request), request.params.id, request.ip),
  );

  app.get<{ Params: { id: string } }>("/drivers/:id/track", async (request) =>
    trackDriver(requireAuth(request), request.params.id),
  );

  app.post<{ Params: { id: string } }>("/drivers/:id/pings", async (request) => {
    const body = pingSchema.parse(request.body);
    return postDriverPing(requireAuth(request), request.params.id, body);
  });

  app.get("/deliveries", async (request) => listDeliveriesFor(requireAuth(request)));

  app.post("/deliveries", async (request) => {
    const body = deliveryCreateSchema.parse(request.body);
    return assignDelivery(requireAuth(request), body, request.ip);
  });

  app.patch<{ Params: { id: string } }>("/deliveries/:id", async (request) => {
    const body = deliveryPatchSchema.parse(request.body);
    return patchDelivery(requireAuth(request), request.params.id, body.status, request.ip);
  });
};

export default driverRoutes;
