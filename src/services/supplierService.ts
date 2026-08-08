import {
  assertOwnsRecord,
  isAdmin,
  requireAdmin,
  requireRole,
  resolveSupplierScope,
  type SessionLike,
  ROLES,
} from "../authz/permissions.js";
import { accessDenied, notFound, validationError } from "../lib/errors.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { centsToRands } from "../lib/money.js";
import { mapSupplier } from "../serializers/dto.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  findSupplierById,
  insertSupplier,
  listSuppliers,
  softDeleteSupplier,
  updateSupplier,
} from "../repositories/supplierRepo.js";
import { listDrivers } from "../repositories/driverRepo.js";
import { listOwnedProductIds } from "../repositories/productRepo.js";
import { listTransactions, supplierSettlement } from "../repositories/transactionRepo.js";
import { createWpUserViaBridge } from "../clients/wordpress.js";
import { uploadImageBuffer } from "./mediaService.js";

export async function listSuppliersFor(session: SessionLike) {
  requireRole(session, ROLES.ADMIN, ROLES.SUPPLIER);
  if (isAdmin(session)) return (await listSuppliers()).map(mapSupplier);
  const scope = resolveSupplierScope(session);
  const rows = await listSuppliers({ id: scope! });
  return rows.map(mapSupplier);
}

export async function getSupplierFor(session: SessionLike, supplierId: string) {
  const scope = resolveSupplierScope(session, supplierId);
  const row = await findSupplierById(scope!);
  if (!row) throw accessDenied("That supplier is not available.");
  return mapSupplier(row);
}

export async function getSupplierBrand(supplierId: string) {
  const row = await findSupplierById(supplierId);
  if (!row || row.status !== "active") return null;
  return { id: row.id, name: row.name, logo: row.logo_url || "" };
}

export async function createSupplierFor(
  session: SessionLike,
  data: {
    name: string;
    contactName?: string;
    email: string;
    phone?: string;
    city?: string;
    password?: string;
  },
  ip?: string,
) {
  requireAdmin(session);
  const email = normalizeEmail(data.email);
  if (!data.name?.trim() || !email) throw validationError("Name and email are required.");

  let wpUserId: number | null = null;
  if (data.password) {
    const wpUser = await createWpUserViaBridge({
      email,
      password: data.password,
      displayName: data.contactName || data.name,
      roles: ["iuw_supplier"],
    });
    wpUserId = wpUser.wpUserId;
  }

  const row = await insertSupplier({
    id: makeId("sup"),
    wp_user_id: wpUserId,
    name: data.name.trim(),
    contact_name: data.contactName?.trim() || "",
    email,
    phone: data.phone?.trim() || "",
    city: data.city?.trim() || "",
    status: "pending",
  });
  await writeAudit({ session, action: "supplier.create", targetType: "supplier", targetId: row.id, ip, after: mapSupplier(row) });
  return mapSupplier(row);
}

export async function updateSupplierFor(
  session: SessionLike,
  supplierId: string,
  changes: Record<string, unknown>,
  ip?: string,
) {
  const scope = resolveSupplierScope(session, supplierId);
  const existing = await findSupplierById(scope!);
  assertOwnsRecord(session, existing ? { supplierId: existing.id } : null, "supplier");

  const safe: Record<string, unknown> = { ...changes };
  if (!isAdmin(session)) delete safe.status;

  const before = mapSupplier(existing!);
  const updated = await updateSupplier(scope!, {
    name: typeof safe.name === "string" ? safe.name : undefined,
    contact_name: typeof safe.contactName === "string" ? safe.contactName : undefined,
    email: typeof safe.email === "string" ? normalizeEmail(safe.email) : undefined,
    phone: typeof safe.phone === "string" ? safe.phone : undefined,
    city: typeof safe.city === "string" ? safe.city : undefined,
    logo_url: typeof safe.logo === "string" ? safe.logo : undefined,
    status:
      isAdmin(session) && (safe.status === "active" || safe.status === "pending" || safe.status === "suspended")
        ? safe.status
        : undefined,
  });
  if (!updated) throw notFound();
  const after = mapSupplier(updated);
  await writeAudit({
    session,
    action: "supplier.update",
    targetType: "supplier",
    targetId: scope!,
    ip,
    before,
    after,
  });
  return after;
}

export async function deleteSupplierFor(session: SessionLike, supplierId: string, ip?: string) {
  requireAdmin(session);
  const existing = await findSupplierById(supplierId);
  if (!existing) throw accessDenied("That supplier is not available.");
  await softDeleteSupplier(supplierId);
  await writeAudit({
    session,
    action: "supplier.delete",
    targetType: "supplier",
    targetId: supplierId,
    ip,
    before: mapSupplier(existing),
  });
  return { id: supplierId };
}

export async function uploadSupplierLogo(
  session: SessionLike,
  supplierId: string,
  buffer: Buffer,
  filename: string,
  ip?: string,
) {
  const scope = resolveSupplierScope(session, supplierId);
  const existing = await findSupplierById(scope!);
  assertOwnsRecord(session, existing ? { supplierId: existing.id } : null, "supplier");
  const { url } = await uploadImageBuffer(buffer, filename);
  return updateSupplierFor(session, scope!, { logo: url }, ip);
}

export async function supplierOverview(session: SessionLike, supplierId: string) {
  const scope = resolveSupplierScope(session, supplierId);
  const [products, drivers, transactions] = await Promise.all([
    listOwnedProductIds(scope),
    listDrivers(scope),
    listTransactions({ supplierId: scope }),
  ]);
  const paid = transactions.filter((t) => t.status === "paid");
  return {
    productCount: products.length,
    activeProducts: products.length,
    outOfStock: 0,
    driverCount: drivers.length,
    availableDrivers: drivers.filter((d) => d.status === "available").length,
    orderCount: transactions.length,
    revenue: centsToRands(paid.reduce((sum, t) => sum + t.total_cents, 0)),
  };
}

export async function supplierSettlementReport(session: SessionLike, supplierId: string) {
  const scope = resolveSupplierScope(session, supplierId);
  const settlement = await supplierSettlement(scope!);
  return {
    supplierId: scope,
    currency: "ZAR",
    paid: centsToRands(settlement.paidCents),
    pending: centsToRands(settlement.pendingCents),
    refunded: centsToRands(settlement.refundedCents),
    orderCount: settlement.orderCount,
    note: "All customer payments settle into the ICE UNDERWATER bank account. This report is for internal allocation only.",
  };
}
