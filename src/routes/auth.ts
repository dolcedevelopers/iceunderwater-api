import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import { login, mePayload, register } from "../services/identityService.js";
import { revokeRefreshToken, rotateRefreshToken } from "../auth/tokens.js";
import { authRequired, accessDenied, AppError } from "../lib/errors.js";
import { config } from "../config.js";
import { createFirstOwner } from "../services/seedOwner.js";

const loginSchema = z
  .object({
    accountType: z.enum(["customer", "supplier", "admin", "driver"]),
    email: z.string().email(),
    password: z.string().min(1),
    siteToken: z.string().optional(),
    /** mobile = Expo app; web = browser. Mobile login kicks other mobile sessions. */
    client: z.enum(["mobile", "web"]).optional(),
  })
  .strict();

const registerSchema = z
  .object({
    accountType: z.enum(["customer", "supplier"]),
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().optional(),
    businessName: z.string().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    client: z.enum(["mobile", "web"]).optional(),
  })
  .strict();

const refreshSchema = z.object({ refreshToken: z.string().min(1) }).strict();

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/login", async (request) => {
    const body = loginSchema.parse(request.body);
    const result = await login(body);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      token: result.accessToken,
      expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS || 43200),
      role: result.principal.role,
      supplierId: result.principal.supplierId || null,
      driverId: result.principal.driverId || null,
      adminRole: result.principal.adminRole || null,
      user: {
        id: String(result.principal.wpUserId || result.principal.driverId || ""),
        email: result.principal.email,
        name: result.principal.email,
      },
    };
  });

  app.post("/auth/register", async (request) => {
    const body = registerSchema.parse(request.body);
    const result = await register(body);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      token: result.accessToken,
      role: result.principal?.role,
      supplierId: result.principal?.supplierId || result.supplier?.id || null,
      supplier: result.supplier || null,
      user: result.principal
        ? {
            id: String(result.principal.wpUserId),
            email: result.principal.email,
            name: body.name || "",
          }
        : null,
    };
  });

  app.post("/auth/refresh", async (request) => {
    const body = refreshSchema.parse(request.body);
    try {
      const result = await rotateRefreshToken(body.refreshToken);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        token: result.accessToken,
        role: result.principal.role,
        supplierId: result.principal.supplierId || null,
        driverId: result.principal.driverId || null,
      };
    } catch {
      throw authRequired("Please sign in again.");
    }
  });

  app.post("/auth/logout", async (request) => {
    const body = refreshSchema.partial().parse(request.body || {});
    if (body.refreshToken) await revokeRefreshToken(body.refreshToken);
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const principal = requireAuth(request);
    return { user: mePayload(principal) };
  });

  /** First-owner bootstrap when iuw_admins is empty. Requires WP bridge secret. */
  app.post("/auth/bootstrap-owner", async (request) => {
    const secret = request.headers["x-iuw-bridge-secret"];
    if (typeof secret !== "string" || secret !== config.WP_BRIDGE_SECRET) {
      throw accessDenied("Forbidden");
    }

    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(1).default("Owner"),
      })
      .strict()
      .parse(request.body);

    try {
      return await createFirstOwner(body);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error instanceof Error ? error.message : "Bootstrap failed.";
      request.log.error({ err: error }, "bootstrap-owner failed");
      throw new AppError(500, "INTERNAL_ERROR", message, { expose: true });
    }
  });
};

export default authRoutes;
