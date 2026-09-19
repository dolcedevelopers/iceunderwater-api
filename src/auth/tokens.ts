import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";
import type { AdminRole, Principal } from "../authz/permissions.js";
import { execute, query } from "../db/pool.js";
import type { RowDataPacket } from "mysql2";

const accessKey = () => new TextEncoder().encode(config.JWT_ACCESS_SECRET);
const refreshKey = () => new TextEncoder().encode(config.JWT_REFRESH_SECRET);

export type ClientKind = "mobile" | "web" | "unknown";

export type AccessClaims = {
  sub: string;
  role: Principal["role"];
  email: string;
  supplierId?: string;
  adminRole?: AdminRole;
  driverId?: string;
  wpUserId: number;
};

export function ownerKeyFor(principal: Principal): string {
  if (principal.driverId) return `driver:${principal.driverId}`;
  return `wp:${principal.wpUserId}`;
}

export async function signAccessToken(principal: Principal): Promise<string> {
  const claims: AccessClaims = {
    sub: String(principal.wpUserId || principal.driverId || ""),
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
    .setSubject(String(principal.wpUserId || principal.driverId || ""))
    .sign(accessKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessKey());
  return payload as unknown as AccessClaims;
}

function hashRefresh(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Revoke every active mobile refresh token for this account (other phones). */
export async function revokeOtherMobileSessions(ownerKey: string, keepJti?: string): Promise<void> {
  if (!ownerKey) return;
  await execute(
    `UPDATE iuw_refresh_tokens
     SET revoked_at = UTC_TIMESTAMP(3)
     WHERE owner_key = :ownerKey
       AND client_kind = 'mobile'
       AND revoked_at IS NULL
       AND (:keepJti = '' OR jti <> :keepJti)`,
    { ownerKey, keepJti: keepJti || "" },
  );
}

export async function issueRefreshToken(
  principal: Principal,
  options?: { clientKind?: ClientKind },
): Promise<string> {
  const clientKind: ClientKind = options?.clientKind || "unknown";
  const ownerKey = ownerKeyFor(principal);
  const jti = randomUUID();

  if (clientKind === "mobile") {
    await revokeOtherMobileSessions(ownerKey);
  }

  const token = await new SignJWT({
    jti,
    role: principal.role,
    supplierId: principal.supplierId,
    adminRole: principal.adminRole,
    driverId: principal.driverId,
    email: principal.email,
    clientKind,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${config.JWT_REFRESH_TTL_SECONDS}s`)
    .setSubject(String(principal.wpUserId || principal.driverId || ""))
    .sign(refreshKey());

  const expires = new Date(Date.now() + config.JWT_REFRESH_TTL_SECONDS * 1000);
  await execute(
    `INSERT INTO iuw_refresh_tokens (jti, wp_user_id, role, client_kind, owner_key, token_hash, expires_at)
     VALUES (:jti, :wpUserId, :role, :clientKind, :ownerKey, :tokenHash, :expiresAt)`,
    {
      jti,
      wpUserId: principal.wpUserId || 0,
      role: principal.role,
      clientKind,
      ownerKey,
      tokenHash: hashRefresh(token),
      expiresAt: expires,
    },
  );
  return token;
}

export async function rotateRefreshToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; principal: Principal }> {
  const { payload } = await jwtVerify(refreshToken, refreshKey());
  const jti = String(payload.jti || "");
  const subject = String(payload.sub || "");
  const wpUserId = Number(payload.sub) || 0;
  if (!jti || !subject) throw new Error("invalid refresh");

  const rows = await query<
    (RowDataPacket & {
      revoked_at: Date | null;
      token_hash: string;
      expires_at: Date;
      client_kind: string;
      owner_key: string;
      wp_user_id: number;
    })[]
  >(
    `SELECT revoked_at, token_hash, expires_at, client_kind, owner_key, wp_user_id
     FROM iuw_refresh_tokens WHERE jti = :jti LIMIT 1`,
    { jti },
  );
  const row = rows[0];
  if (!row || row.revoked_at || row.token_hash !== hashRefresh(refreshToken) || new Date(row.expires_at) < new Date()) {
    if (row?.owner_key) {
      await execute(
        `UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE owner_key = :ownerKey AND revoked_at IS NULL`,
        { ownerKey: row.owner_key },
      );
    } else if (wpUserId) {
      await execute(`UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE wp_user_id = :wpUserId AND revoked_at IS NULL`, {
        wpUserId,
      });
    }
    throw new Error("refresh reused or invalid");
  }

  await execute(`UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE jti = :jti`, { jti });

  const principal: Principal = {
    sub: wpUserId || 0,
    wpUserId: Number(row.wp_user_id) || wpUserId,
    role: payload.role as Principal["role"],
    email: String(payload.email || ""),
    supplierId: payload.supplierId ? String(payload.supplierId) : undefined,
    adminRole: payload.adminRole as AdminRole | undefined,
    driverId: payload.driverId ? String(payload.driverId) : undefined,
  };

  const clientKind = (row.client_kind === "mobile" || row.client_kind === "web" ? row.client_kind : "unknown") as ClientKind;
  const accessToken = await signAccessToken(principal);
  // Rotation keeps the same client; do not revoke sibling mobile sessions here.
  const nextRefresh = await issueRefreshTokenWithoutRevoke(principal, clientKind);
  await execute(`UPDATE iuw_refresh_tokens SET replaced_by = :next WHERE jti = :jti`, {
    next: createHash("sha256").update(nextRefresh).digest("hex").slice(0, 64),
    jti,
  });

  return { accessToken, refreshToken: nextRefresh, principal };
}

async function issueRefreshTokenWithoutRevoke(principal: Principal, clientKind: ClientKind): Promise<string> {
  const ownerKey = ownerKeyFor(principal);
  const jti = randomUUID();
  const token = await new SignJWT({
    jti,
    role: principal.role,
    supplierId: principal.supplierId,
    adminRole: principal.adminRole,
    driverId: principal.driverId,
    email: principal.email,
    clientKind,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${config.JWT_REFRESH_TTL_SECONDS}s`)
    .setSubject(String(principal.wpUserId || principal.driverId || ""))
    .sign(refreshKey());

  const expires = new Date(Date.now() + config.JWT_REFRESH_TTL_SECONDS * 1000);
  await execute(
    `INSERT INTO iuw_refresh_tokens (jti, wp_user_id, role, client_kind, owner_key, token_hash, expires_at)
     VALUES (:jti, :wpUserId, :role, :clientKind, :ownerKey, :tokenHash, :expiresAt)`,
    {
      jti,
      wpUserId: principal.wpUserId || 0,
      role: principal.role,
      clientKind,
      ownerKey,
      tokenHash: hashRefresh(token),
      expiresAt: expires,
    },
  );
  return token;
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
