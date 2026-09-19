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

function hasRole(roles: string[], needle: string): boolean {
  return roles.map((r) => r.toLowerCase()).includes(needle.toLowerCase());
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
  name?: string;
  businessName?: string;
  phone?: string;
  city?: string;
  client?: ClientKind;
}): Promise<{ accessToken?: string; refreshToken?: string; principal?: Principal; supplier?: { id: string; status: string } }> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password) throw validationError("Enter your email address and a password.");
  if (input.password.length < 8) throw validationError("Use a password of at least 8 characters.");
  const clientKind: ClientKind = input.client === "mobile" || input.client === "web" ? input.client : "unknown";

  if (input.accountType === "customer") {
    const wpUser = await registerWpCustomer(email, input.password, input.name || "");
    const principal = await principalFromWpUser(wpUser);
    return {
      accessToken: await signAccessToken(principal),
      refreshToken: await issueRefreshToken(principal, { clientKind }),
      principal,
    };
  }

  if (!input.businessName?.trim()) throw validationError("Enter your trading name.");

  const wpUser = await createWpUserViaBridge({
    email,
    password: input.password,
    displayName: input.name || input.businessName,
    roles: ["iuw_supplier"],
  });

  const supplier = await insertSupplier({
    id: makeId("sup"),
    wp_user_id: wpUser.wpUserId,
    name: input.businessName.trim(),
    contact_name: input.name?.trim() || "",
    email,
    phone: input.phone?.trim() || "",
    city: input.city?.trim() || "",
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
