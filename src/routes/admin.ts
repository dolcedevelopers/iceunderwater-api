import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  adminOverview,
  createAdminFor,
  createCustomerFor,
  deleteAdminFor,
  deleteCustomerFor,
  getCustomerFor,
  listAdminsFor,
  listCustomersFor,
  updateAdminFor,
  updateCustomerFor,
} from "../services/adminService.js";

const customerCreateSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    phone: z.string().optional(),
    city: z.string().optional(),
  })
  .strict();

const customerPatchSchema = z
  .object({
    status: z.enum(["active", "blocked"]).optional(),
    notes: z.string().optional(),
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.status != null ||
      body.notes != null ||
      body.name != null ||
      body.email != null ||
      body.phone != null ||
      body.city != null,
    { message: "Provide at least one field to update." },
  );

const adminCreateSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(["owner", "manager", "support"]).optional(),
  })
  .strict();

const adminPatchSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    role: z.enum(["owner", "manager", "support"]).optional(),
    status: z.string().optional(),
  })
  .strict();

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/customers", async (request) => listCustomersFor(requireAuth(request)));
  app.get<{ Params: { id: string } }>("/customers/:id", async (request) =>
    getCustomerFor(requireAuth(request), request.params.id),
  );
  app.post("/customers", async (request) => {
    const body = customerCreateSchema.parse(request.body);
    return createCustomerFor(requireAuth(request), body, request.ip);
  });
  app.patch<{ Params: { id: string } }>("/customers/:id", async (request) => {
    const body = customerPatchSchema.parse(request.body);
    return updateCustomerFor(requireAuth(request), request.params.id, body, request.ip);
  });
  app.delete<{ Params: { id: string } }>("/customers/:id", async (request) =>
    deleteCustomerFor(requireAuth(request), request.params.id, request.ip),
  );

  app.get("/admins", async (request) => listAdminsFor(requireAuth(request)));
  app.post("/admins", async (request) => {
    const body = adminCreateSchema.parse(request.body);
    return createAdminFor(requireAuth(request), body, request.ip);
  });
  app.patch<{ Params: { id: string } }>("/admins/:id", async (request) => {
    const body = adminPatchSchema.parse(request.body);
    return updateAdminFor(requireAuth(request), request.params.id, body, request.ip);
  });
  app.delete<{ Params: { id: string } }>("/admins/:id", async (request) =>
    deleteAdminFor(requireAuth(request), request.params.id, request.ip),
  );

  app.get("/admin/overview", async (request) => adminOverview(requireAuth(request)));
};

export default adminRoutes;
