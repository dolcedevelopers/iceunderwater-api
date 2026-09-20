import {
  assertOwnsRecord,
  isAdmin,
  isCustomer,
  requireAdmin,
  requireRole,
  resolveSupplierScope,
  type SessionLike,
  ROLES,
} from "../authz/permissions.js";
import { accessDenied, notFound, validationError } from "../lib/errors.js";
import { isHostedImageUrl, publicHttpsUrl } from "../lib/mediaUrl.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { centsToRands } from "../lib/money.js";
import { mapSupplier, type SupplierDto } from "../serializers/dto.js";
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
import { repriceSupplierProducts } from "./productService.js";
import { assertKnownCity, findCity } from "../data/saLocations.js";

function resolveCityProvince(cityRaw?: string) {
  try {
    const found = assertKnownCity(cityRaw);
    if (!found) return { city: "", province: "" };
    return { city: found.city, province: found.province };
  } catch {
    throw validationError("Choose a city from the list.");
  }
}

export async function listSuppliersFor(
  session: SessionLike,
  opts: { city?: string; province?: string; status?: string } = {},
) {
  requireRole(session, ROLES.ADMIN, ROLES.SUPPLIER);
  if (isAdmin(session)) {
    return (
      await listSuppliers({
        status: opts.status,
        city: opts.city,
        province: opts.province,
      })
    ).map(mapSupplier);
  }
  const scope = resolveSupplierScope(session);
  const rows = await listSuppliers({ id: scope! });
  return rows.map(mapSupplier);
}

/**
 * Markup is our pricing arrangement with each company, so it never leaves the
 * admin console — a customer browsing the directory must not see it, and one
 * company must never see another's.
 */
function toDirectoryEntry(row: SupplierDto): SupplierDto {
  return { ...row, markupPercent: 0 };
}

/**
 * Customer + admin company directory. Never hard-excludes other areas —
 * returns near / province / national buckets (filtered view still includes others).
 *
 * Companies are deliberately excluded: they manage their own catalogue and have
 * no business browsing competitors through this endpoint.
 */
export async function listCompaniesDirectory(
  session: SessionLike | null,
  opts: {
    city?: string;
    province?: string;
    scope?: "city" | "province" | "national";
    viewerCity?: string;
  } = {},
) {
  requireRole(session, ROLES.CUSTOMER, ROLES.ADMIN);
  const showInternal = isAdmin(session);
  const rows = (await listSuppliers({ status: "active" })).map((row) => {
    const dto = mapSupplier(row);
    return showInternal ? dto : toDirectoryEntry(dto);
  });
  const viewerCity =
    opts.viewerCity ||
    opts.city ||
    (session && isCustomer(session) ? "" : "") ||
    "";
  const viewer = findCity(viewerCity);
  const filterCity = opts.city ? findCity(opts.city) : viewer;
  const filterProvince = opts.province || filterCity?.province || "";

  const near = filterCity
    ? rows.filter((row) => row.city.toLowerCase() === filterCity.city.toLowerCase())
    : [];
  const province = filterProvince
    ? rows.filter(
        (row) =>
          row.province.toLowerCase() === filterProvince.toLowerCase() &&
          !near.some((n) => n.id === row.id),
      )
    : [];
  const nearAndProvinceIds = new Set([...near, ...province].map((r) => r.id));
  const national = rows.filter((row) => !nearAndProvinceIds.has(row.id));

  const scope = opts.scope || "national";
  let primary: SupplierDto[] = rows;
  if (scope === "city") primary = near.length ? near : rows;
  else if (scope === "province") primary = [...near, ...province].length ? [...near, ...province] : rows;

  return {
    scope,
    viewerCity: filterCity?.city || "",
    viewerProvince: filterProvince,
    primary,
    near,
    province,
    national: scope === "national" ? rows : national,
    all: rows,
  };
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
  return { id: row.id, name: row.name, logo: publicHttpsUrl(row.logo_url) };
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
    markupPercent?: number;
  },
  ip?: string,
) {
  requireAdmin(session);
  const email = normalizeEmail(data.email);
  if (!data.name?.trim() || !email) throw validationError("Name and email are required.");
  const loc = resolveCityProvince(data.city);

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
    city: loc.city,
    province: loc.province,
    status: "pending",
  });

  const markup =
    typeof data.markupPercent === "number" && Number.isFinite(data.markupPercent)
      ? Math.max(0, data.markupPercent)
      : 0;
  const withMarkup =
    markup > 0 ? (await updateSupplier(row.id, { markup_percent: markup })) || row : row;

  await writeAudit({
    session,
    action: "supplier.create",
    targetType: "supplier",
    targetId: withMarkup.id,
    ip,
    after: mapSupplier(withMarkup),
  });
  return mapSupplier(withMarkup);
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
  if (!isAdmin(session)) {
    delete safe.status;
    delete safe.markupPercent;
  }

  const before = mapSupplier(existing!);
  const markupPercent =
    isAdmin(session) && typeof safe.markupPercent === "number" && Number.isFinite(safe.markupPercent)
      ? Math.max(0, Number(safe.markupPercent))
      : undefined;

  let city: string | undefined;
  let province: string | undefined;
  if (typeof safe.city === "string") {
    const loc = resolveCityProvince(safe.city);
    city = loc.city;
    province = loc.province;
  }

  const updated = await updateSupplier(scope!, {
    name: typeof safe.name === "string" ? safe.name : undefined,
    contact_name: typeof safe.contactName === "string" ? safe.contactName : undefined,
    email: typeof safe.email === "string" ? normalizeEmail(safe.email) : undefined,
    phone: typeof safe.phone === "string" ? safe.phone : undefined,
    city,
    province,
    logo_url:
      typeof safe.logo === "string"
        ? safe.logo === ""
          ? ""
          : isHostedImageUrl(safe.logo)
            ? publicHttpsUrl(safe.logo)
            : undefined
        : undefined,
    status:
      isAdmin(session) && (safe.status === "active" || safe.status === "pending" || safe.status === "suspended")
        ? safe.status
        : undefined,
    markup_percent: markupPercent,
  });
  if (!updated) throw notFound();

  if (markupPercent != null && markupPercent !== Number(existing!.markup_percent || 0)) {
    await repriceSupplierProducts(scope!);
  }

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
