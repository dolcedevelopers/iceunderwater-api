/**
 * Server-side mirror of mobile-app/src/api/permissions.js.
 * Every private route must go through these helpers — never ad-hoc role checks in handlers.
 */

import { accessDenied, authRequired } from "../lib/errors.js";
import { normalizeEmail } from "../lib/ids.js";

export const ROLES = {
  GUEST: "guest",
  CUSTOMER: "customer",
  SUPPLIER: "supplier",
  ADMIN: "admin",
  DRIVER: "driver",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
export type AdminRole = "owner" | "manager" | "support";

export type Principal = {
  sub: number;
  role: Exclude<Role, "guest">;
  email: string;
  supplierId?: string;
  adminRole?: AdminRole;
  driverId?: string;
  wpUserId: number;
};

export type SessionLike = Principal | null | undefined;

export type OwnedRecord = { supplierId: string } | null | undefined;

export type TransactionAccess = {
  supplierId: string;
  customerEmail: string;
  customerId?: string | number | null;
} | null | undefined;

export function roleOf(session: SessionLike): Role {
  const role = session?.role;
  if (role === ROLES.CUSTOMER || role === ROLES.SUPPLIER || role === ROLES.ADMIN || role === ROLES.DRIVER) {
    return role;
  }
  return ROLES.GUEST;
}

export const isAdmin = (session: SessionLike) => roleOf(session) === ROLES.ADMIN;
export const isSupplier = (session: SessionLike) => roleOf(session) === ROLES.SUPPLIER;
export const isCustomer = (session: SessionLike) => roleOf(session) === ROLES.CUSTOMER;
export const isDriver = (session: SessionLike) => roleOf(session) === ROLES.DRIVER;
export const isSignedIn = (session: SessionLike) => roleOf(session) !== ROLES.GUEST;

export function identityEmail(session: SessionLike): string {
  return normalizeEmail(session?.email || "");
}

export function requireSignedIn(session: SessionLike): Principal {
  if (!isSignedIn(session) || !session) throw authRequired();
  return session;
}

export function requireRole(session: SessionLike, ...allowed: Role[]): Principal {
  const principal = requireSignedIn(session);
  if (!allowed.includes(roleOf(principal))) {
    throw accessDenied("Your account cannot perform that action.");
  }
  return principal;
}

export function requireAdmin(session: SessionLike): Principal {
  const principal = requireSignedIn(session);
  if (!isAdmin(principal)) throw accessDenied("Only administrators can do that.");
  return principal;
}

/**
 * Supplier scope is pinned to the token. Passing another supplier's id is 403, not an empty list.
 * Admins may target any supplier or null (all).
 */
export function resolveSupplierScope(session: SessionLike, requestedId?: string | null): string | null {
  if (isAdmin(session)) return requestedId || null;
  if (isSupplier(session)) {
    const own = session?.supplierId;
    if (!own) throw accessDenied("This supplier account is not linked to a business yet.");
    if (requestedId && requestedId !== own) {
      throw accessDenied("You can only manage your own business.");
    }
    return own;
  }
  throw accessDenied("Only suppliers and administrators can manage supplier data.");
}

/**
 * Ownership re-check. Missing and foreign records share the same 403 shape (no existence leak).
 */
export function assertOwnsRecord<T extends OwnedRecord>(session: SessionLike, record: T, label = "record"): NonNullable<T> {
  if (!record) throw accessDenied(`That ${label} is not available.`);
  if (isAdmin(session)) return record as NonNullable<T>;
  if (isSupplier(session) && record.supplierId === session?.supplierId) return record as NonNullable<T>;
  throw accessDenied(`That ${label} is not available.`);
}

export function canAccessTransaction(session: SessionLike, transaction: TransactionAccess): boolean {
  if (!transaction) return false;
  if (isAdmin(session)) return true;
  if (isSupplier(session)) return transaction.supplierId === session?.supplierId;
  if (isCustomer(session)) {
    const email = identityEmail(session);
    if (!email) return false;
    const owner = normalizeEmail(transaction.customerEmail || "");
    const customerId = transaction.customerId != null ? String(transaction.customerId) : "";
    const selfId = session?.wpUserId != null ? String(session.wpUserId) : "";
    return owner === email || (Boolean(customerId) && customerId === selfId);
  }
  return false;
}

export function requireTransactionAccess(session: SessionLike, transaction: TransactionAccess): void {
  requireSignedIn(session);
  if (!canAccessTransaction(session, transaction)) {
    throw accessDenied("That receipt is not available.");
  }
}
