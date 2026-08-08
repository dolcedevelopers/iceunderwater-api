import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import type { AdminRole, Principal } from "../authz/permissions.js";
import { execute, query } from "../db/pool.js";
import type { RowDataPacket } from "mysql2";

const accessKey = () => new TextEncoder().encode(config.JWT_ACCESS_SECRET);
const refreshKey = () => new TextEncoder().encode(config.JWT_REFRESH_SECRET);

export type AccessClaims = {
  sub: string;
  role: Principal["role"];
  email: string;
  supplierId?: string;
  adminRole?: AdminRole;
  driverId?: string;
  wpUserId: number;
};

export async function signAccessToken(principal: Principal): Promise<string> {
  const claims: AccessClaims = {
    sub: String(principal.wpUserId),
    role: principal.role,
    email: principal.email,
    wpUserId: principal.wpUserId,
  };
  if (principal.supplierId) claims.supplierId = principal.supplierId;
  if (principal.adminRole) claims.adminRole = principal.adminRole;
  if (principal.driverId) claims.driverId = principal.driverId;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${config.JWT_ACCESS_TTL_SECONDS}s`)
    .setSubject(String(principal.wpUserId))
    .sign(accessKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessKey());
  return payload as unknown as AccessClaims;
}

function hashRefresh(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(principal: Principal): Promise<string> {
  const jti = randomUUID();
  const token = await new SignJWT({
    jti,
    role: principal.role,
    supplierId: principal.supplierId,
    adminRole: principal.adminRole,
    driverId: principal.driverId,
    email: principal.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${config.JWT_REFRESH_TTL_SECONDS}s`)
    .setSubject(String(principal.wpUserId))
    .sign(refreshKey());

  const expires = new Date(Date.now() + config.JWT_REFRESH_TTL_SECONDS * 1000);
  await execute(
    `INSERT INTO iuw_refresh_tokens (jti, wp_user_id, role, token_hash, expires_at)
     VALUES (:jti, :wpUserId, :role, :tokenHash, :expiresAt)`,
    {
      jti,
      wpUserId: principal.wpUserId,
      role: principal.role,
      tokenHash: hashRefresh(token),
      expiresAt: expires,
    },
  );
  return token;
}

export async function rotateRefreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; principal: Principal }> {
  const { payload } = await jwtVerify(refreshToken, refreshKey());
  const jti = String(payload.jti || "");
  const wpUserId = Number(payload.sub);
  if (!jti || !wpUserId) throw new Error("invalid refresh");

  const rows = await query<(RowDataPacket & { revoked_at: Date | null; token_hash: string; expires_at: Date })[]>(
    `SELECT revoked_at, token_hash, expires_at FROM iuw_refresh_tokens WHERE jti = :jti AND wp_user_id = :wpUserId LIMIT 1`,
    { jti, wpUserId },
  );
  const row = rows[0];
  if (!row || row.revoked_at || row.token_hash !== hashRefresh(refreshToken) || new Date(row.expires_at) < new Date()) {
    await execute(`UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE wp_user_id = :wpUserId AND revoked_at IS NULL`, {
      wpUserId,
    });
    throw new Error("refresh reused or invalid");
  }

  await execute(`UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE jti = :jti`, { jti });

  const principal: Principal = {
    sub: wpUserId,
    wpUserId,
    role: payload.role as Principal["role"],
    email: String(payload.email || ""),
    supplierId: payload.supplierId ? String(payload.supplierId) : undefined,
    adminRole: payload.adminRole as AdminRole | undefined,
    driverId: payload.driverId ? String(payload.driverId) : undefined,
  };

  const accessToken = await signAccessToken(principal);
  const nextRefresh = await issueRefreshToken(principal);
  await execute(`UPDATE iuw_refresh_tokens SET replaced_by = :next WHERE jti = :jti`, {
    next: createHash("sha256").update(nextRefresh).digest("hex").slice(0, 64),
    jti,
  });

  return { accessToken, refreshToken: nextRefresh, principal };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const { payload } = await jwtVerify(refreshToken, refreshKey());
    const jti = String(payload.jti || "");
    if (!jti) return;
    await execute(`UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE jti = :jti`, { jti });
  } catch {
    // ignore invalid tokens on logout
  }
}

export function claimsToPrincipal(claims: AccessClaims): Principal {
  return {
    sub: claims.wpUserId,
    wpUserId: claims.wpUserId,
    role: claims.role,
    email: claims.email,
    supplierId: claims.supplierId,
    adminRole: claims.adminRole,
    driverId: claims.driverId,
  };
}
