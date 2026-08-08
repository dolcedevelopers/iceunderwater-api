import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "./fp.js";
import { claimsToPrincipal, verifyAccessToken } from "../auth/tokens.js";
import type { Principal } from "../authz/permissions.js";
import { authRequired } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (request) => {
    request.principal = null;
    const token = extractBearer(request);
    if (!token) return;
    try {
      const claims = await verifyAccessToken(token);
      request.principal = claimsToPrincipal(claims);
    } catch {
      // Leave principal null; route guards decide 401 vs public.
      request.authTokenInvalid = true;
    }
  });
};

declare module "fastify" {
  interface FastifyRequest {
    authTokenInvalid?: boolean;
  }
}

export function requireAuth(request: FastifyRequest): Principal {
  if (request.principal) return request.principal;
  if (request.authTokenInvalid) throw authRequired("Please sign in again.");
  throw authRequired();
}

export default fp(authPlugin, { name: "auth" });
