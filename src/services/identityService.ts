import {
  ROLES,
  type Principal,
  type AdminRole,
} from "../authz/permissions.js";
import { accessDenied, authRequired, validationError } from "../lib/errors.js";
import { normalizeEmail } from "../lib/ids.js";
import {
  createWpUserViaBridge,
  registerWpCustomer,
  resolveSiteToken,
  verifyWpCredentials,
} from "../clients/wordpress.js";
import { findAdminByWpUserId } from "../repositories/adminRepo.js";
import { findSupplierByWpUserId, insertSupplier } from "../repositories/supplierRepo.js";
import { findDriverByEmail } from "../repositories/driverRepo.js";
import { verifyPassword } from "../auth/password.js";
import { makeId } from "../lib/ids.js";
import { issueRefreshToken, signAccessToken, type ClientKind } from "../auth/tokens.js";
import { assertKnownCity } from "../data/saLocations.js";
import { execute, query } from "../db/pool.js";
import { isHostedImageUrl, publicHttpsUrl } from "../lib/mediaUrl.js";
import type { RowDataPacket } from "mysql2";
import type { SessionLike } from "../authz/permissions.js";
import { requireSignedIn } from "../authz/permissions.js";

function hasRole(roles: string[], needle: string): boolean {
  return roles.map((r) => r.toLowerCase()).includes(needle.toLowerCase());
}

async function upsertUserMeta(userId: number, metaKey: string, metaValue: string) {
  const existing = await query<(RowDataPacket & { umeta_id: number })[]>(
    `SELECT umeta_id FROM wp_usermeta WHERE user_id = :userId AND meta_key = :metaKey LIMIT 1`,
    { userId, metaKey },
  );
  if (existing[0]?.umeta_id) {
    await execute(`UPDATE wp_usermeta SET meta_value = :metaValue WHERE umeta_id = :id`, {
      metaValue,
      id: existing[0].umeta_id,
    });
    return;
  }
  await execute(`INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (:userId, :metaKey, :metaValue)`, {
    userId,
    metaKey,
    metaValue,
  });
}

function optionalPhotoUrl(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!isHostedImageUrl(raw)) throw validationError("Photo URL is not valid.");
  return publicHttpsUrl(raw);
}

/** Resolve a verified WP user into an API principal. */
export async function principalFromWpUser(user: {
  wpUserId: number;
  email: string;
  displayName: string;
  roles: string[];
}): Promise<Principal> {
  if (hasRole(user.roles, "iuw_admin") || hasRole(user.roles, "administrator")) {
    const admin = await findAdminByWpUserId(user.wpUserId);
    if (!admin || admin.status !== "active") throw accessDenied("This admin account is not active.");
    return {
      sub: user.wpUserId,
      wpUserId: user.wpUserId,
      role: ROLES.ADMIN,
      email: normalizeEmail(user.email),
      adminRole: admin.role as AdminRole,
    };
  }

  if (hasRole(user.roles, "iuw_supplier")) {
    const supplier = await findSupplierByWpUserId(user.wpUserId);
    if (!supplier) throw accessDenied("This supplier account is not linked to a business yet.");
    return {
      sub: user.wpUserId,
      wpUserId: user.wpUserId,
      role: ROLES.SUPPLIER,
      email: normalizeEmail(user.email),
      supplierId: supplier.id,
    };
  }

  return {
    sub: user.wpUserId,
    wpUserId: user.wpUserId,
    role: ROLES.CUSTOMER,
    email: normalizeEmail(user.email),
  };
}

export async function login(input: {
  accountType: "customer" | "supplier" | "admin" | "driver";
  email: string;
  password: string;
  siteToken?: string;
  client?: ClientKind;
}): Promise<{ accessToken: string; refreshToken: string; principal: Principal }> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password) throw validationError("Enter your email address and password.");
  const clientKind: ClientKind = input.client === "mobile" || input.client === "web" ? input.client : "unknown";

  if (input.accountType === "driver") {
    const driver = await findDriverByEmail(email);
    if (!driver?.password_hash || !(await verifyPassword(driver.password_hash, input.password))) {
      throw authRequired("The login details are incorrect.");
    }
    if (!driver.active) throw accessDenied("This driver account is inactive.");
    const principal: Principal = {
      sub: 0,
      wpUserId: 0,
      role: ROLES.DRIVER,
      email,
      supplierId: driver.supplier_id,
      driverId: driver.id,
    };
    return {
      accessToken: await signAccessToken(principal),
      refreshToken: await issueRefreshToken(principal, { clientKind }),
      principal,
    };
  }

  let wpUser;
  if (input.accountType === "customer" && input.siteToken) {
    wpUser = await resolveSiteToken(input.siteToken);
  } else {
    wpUser = await verifyWpCredentials(email, input.password);
  }

  const principal = await principalFromWpUser(wpUser);

  if (input.accountType === "supplier" && principal.role !== ROLES.SUPPLIER) {
    throw authRequired("That account is not a supplier account.");
  }
  if (input.accountType === "admin" && principal.role !== ROLES.ADMIN) {
    throw authRequired("That account is not an admin account.");
  }
  if (input.accountType === "customer" && principal.role === ROLES.SUPPLIER) {
    throw authRequired("That is a supplier account. Choose Supplier to sign in.");
  }
  // Admin signing in through customer form still gets their real role (matches app auth.js).

  return {
    accessToken: await signAccessToken(principal),
    refreshToken: await issueRefreshToken(principal, { clientKind }),
    principal,
  };
}

export async function register(input: {
  accountType: "customer" | "supplier";
  email: string;
  password: string;
  passwordConfirm?: string;
  name?: string;
  businessName?: string;
  phone?: string;
  city?: string;
  vatNumber?: string;
  registrationNumber?: string;
  address?: string;
  avatarUrl?: string;
  groupPhotoUrl?: string;
  client?: ClientKind;
}): Promise<{ accessToken?: string; refreshToken?: string; principal?: Principal; supplier?: { id: string; status: string } }> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password) throw validationError("Enter your email address and a password.");
  if (input.password.length < 8) throw validationError("Use a password of at least 8 characters.");
  if (input.passwordConfirm != null && input.passwordConfirm !== input.password) {
    throw validationError("Passwords do not match.");
  }
  const clientKind: ClientKind = input.client === "mobile" || input.client === "web" ? input.client : "unknown";

  let city = "";
  let province = "";
  if (input.city?.trim()) {
    try {
      const found = assertKnownCity(input.city);
      city = found?.city || "";
      province = found?.province || "";
    } catch {
      throw validationError("Choose a city from the list.");
    }
  }

  const avatarUrl = optionalPhotoUrl(input.avatarUrl);
  const groupPhotoUrl = optionalPhotoUrl(input.groupPhotoUrl);

  if (input.accountType === "customer") {
    const wpUser = await registerWpCustomer(email, input.password, input.name || "");
    if (city) await upsertUserMeta(wpUser.wpUserId, "billing_city", city);
    if (input.phone?.trim()) await upsertUserMeta(wpUser.wpUserId, "billing_phone", input.phone.trim());
    if (avatarUrl) await upsertUserMeta(wpUser.wpUserId, "iuw_avatar_url", avatarUrl);
    if (groupPhotoUrl) await upsertUserMeta(wpUser.wpUserId, "iuw_group_photo_url", groupPhotoUrl);
    const principal = await principalFromWpUser(wpUser);
    return {
      accessToken: await signAccessToken(principal),
      refreshToken: await issueRefreshToken(principal, { clientKind }),
      principal,
    };
  }

  if (!input.businessName?.trim()) throw validationError("Enter your trading name.");
  if (!city) throw validationError("Choose a city from the list.");

  const wpUser = await createWpUserViaBridge({
    email,
    password: input.password,
    displayName: input.name || input.businessName,
    roles: ["iuw_supplier"],
  });

  if (avatarUrl) await upsertUserMeta(wpUser.wpUserId, "iuw_avatar_url", avatarUrl);

  const supplier = await insertSupplier({
    id: makeId("sup"),
    wp_user_id: wpUser.wpUserId,
    name: input.businessName.trim(),
    contact_name: input.name?.trim() || "",
    email,
    phone: input.phone?.trim() || "",
    city,
    province,
    vat_number: input.vatNumber?.trim() || "",
    registration_number: input.registrationNumber?.trim() || "",
    address: input.address?.trim() || "",
    status: "pending",
  });

  const principal = await principalFromWpUser({ ...wpUser, roles: ["iuw_supplier"] });
  return {
    accessToken: await signAccessToken(principal),
    refreshToken: await issueRefreshToken(principal, { clientKind }),
    principal,
    supplier: { id: supplier.id, status: supplier.status },
  };
}

export async function updateMyPhotos(
  session: SessionLike,
  data: { avatarUrl?: string; groupPhotoUrl?: string },
) {
  const principal = requireSignedIn(session);
  if (!principal.wpUserId) throw validationError("Photos are only available for website accounts.");
  const avatarUrl = data.avatarUrl !== undefined ? optionalPhotoUrl(data.avatarUrl) : undefined;
  const groupPhotoUrl = data.groupPhotoUrl !== undefined ? optionalPhotoUrl(data.groupPhotoUrl) : undefined;
  if (avatarUrl !== undefined) await upsertUserMeta(principal.wpUserId, "iuw_avatar_url", avatarUrl);
  if (groupPhotoUrl !== undefined) await upsertUserMeta(principal.wpUserId, "iuw_group_photo_url", groupPhotoUrl);
  return { ok: true, avatarUrl: avatarUrl ?? null, groupPhotoUrl: groupPhotoUrl ?? null };
}

export function mePayload(principal: Principal) {
  return {
    id: String(principal.wpUserId || principal.driverId || ""),
    role: principal.role,
    email: principal.email,
    supplierId: principal.supplierId || null,
    adminRole: principal.adminRole || null,
    driverId: principal.driverId || null,
  };
}

/** Own account only: the subject comes exclusively from the authenticated token. */
export async function myProfileFor(session: SessionLike) {
  const principal = requireSignedIn(session);
  if (!principal.wpUserId) return { name: principal.email, email: principal.email, avatarUrl: "" };
  const rows = await query<RowDataPacket[]>(
    `SELECT display_name AS name, user_email AS email,
      (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'iuw_avatar_url' ORDER BY umeta_id DESC LIMIT 1) AS avatarUrl
      FROM wp_users u WHERE u.ID = :id LIMIT 1`, { id: principal.wpUserId });
  const row = rows[0];
  return { name: row?.name || principal.email, email: row?.email || principal.email, avatarUrl: row?.avatarUrl || "" };
}
