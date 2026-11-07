import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import { login, mePayload, register, updateMyPhotos, myProfileFor } from "../services/identityService.js";
import { revokeRefreshToken, rotateRefreshToken } from "../auth/tokens.js";
import { authRequired, accessDenied, AppError } from "../lib/errors.js";
import { config } from "../config.js";
import { createFirstOwner } from "../services/seedOwner.js";
import { readImageFromRequest } from "../lib/uploadRequest.js";
import { uploadImageBuffer } from "../services/mediaService.js";
import { changePasswordFor } from "../services/passwordService.js";

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
    passwordConfirm: z.string().optional(),
    name: z.string().optional(),
    businessName: z.string().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    /** Company invoice identity — optional at sign-up, editable later in the console. */
    vatNumber: z.string().max(64, "VAT number is too long.").optional(),
    registrationNumber: z.string().max(64, "Company registration number is too long.").optional(),
    address: z.string().max(512, "Address is too long.").optional(),
    avatarUrl: z.string().optional(),
    groupPhotoUrl: z.string().optional(),
    client: z.enum(["mobile", "web"]).optional(),
  })
  .strict();

const photosSchema = z
  .object({
    avatarUrl: z.string().optional(),
    groupPhotoUrl: z.string().optional(),
  })
  .strict();

const refreshSchema = z.object({ refreshToken: z.string().min(1) }).strict();

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me/profile", async (request) => myProfileFor(requireAuth(request)));
  app.post("/auth/password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request) => {
    const principal = requireAuth(request);
    const input = z.object({ currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128), passwordConfirm: z.string().min(1).max(128) }).strict().parse(request.body);
    return changePasswordFor(principal, input, request.ip);
  });
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

  app.post("/me/photos", async (request) => {
    const body = photosSchema.parse(request.body);
    return updateMyPhotos(requireAuth(request), body);
  });

  app.post("/me/photos/upload", async (request) => {
    const principal = requireAuth(request);
    const { buffer, filename } = await readImageFromRequest(request);
    const { url } = await uploadImageBuffer(buffer, filename);
    const kind = String((request.query as { kind?: string })?.kind || "avatar");
    if (kind === "group") {
      return updateMyPhotos(principal, { groupPhotoUrl: url });
    }
    return updateMyPhotos(principal, { avatarUrl: url });
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
