import { requireAdmin, type SessionLike } from "../authz/permissions.js";
import { accessDenied, conflict, validationError } from "../lib/errors.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { centsToRands } from "../lib/money.js";
import { mapAdmin, type CustomerDto } from "../serializers/dto.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  countActiveOwners,
  findAdminById,
  insertAdmin,
  listAdmins,
  softDeleteAdmin,
  updateAdmin,
} from "../repositories/adminRepo.js";
import { listSuppliers } from "../repositories/supplierRepo.js";
import { listTransactions } from "../repositories/transactionRepo.js";
import { createWpUserViaBridge } from "../clients/wordpress.js";
import { execute, query } from "../db/pool.js";
import type { RowDataPacket } from "mysql2";

export async function listAdminsFor(session: SessionLike) {
  requireAdmin(session);
  return (await listAdmins()).map(mapAdmin);
}

export async function createAdminFor(
  session: SessionLike,
  data: { name: string; email: string; password: string; role?: "owner" | "manager" | "support" },
  ip?: string,
) {
  requireAdmin(session);
  const email = normalizeEmail(data.email);
  if (!data.name?.trim() || !email || !data.password) throw validationError("Name, email and password are required.");

  const wpUser = await createWpUserViaBridge({
    email,
    password: data.password,
    displayName: data.name,
    roles: ["iuw_admin"],
  });

  const row = await insertAdmin({
    id: makeId("adm"),
    wp_user_id: wpUser.wpUserId,
    name: data.name.trim(),
    email,
    role: data.role || "support",
  });
  const dto = mapAdmin(row);
  await writeAudit({ session, action: "admin.create", targetType: "admin", targetId: row.id, ip, after: dto });
  return dto;
}

export async function updateAdminFor(
  session: SessionLike,
  adminId: string,
  changes: Record<string, unknown>,
  ip?: string,
) {
  requireAdmin(session);
  const existing = await findAdminById(adminId);
  if (!existing) throw accessDenied("That admin is not available.");

  if (
    existing.role === "owner" &&
    (changes.role === "manager" || changes.role === "support" || changes.status === "disabled")
  ) {
    const owners = await countActiveOwners();
    if (owners <= 1) throw conflict("Cannot demote or disable the last owner admin.");
  }

  const updated = await updateAdmin(adminId, {
    name: typeof changes.name === "string" ? changes.name : undefined,
    email: typeof changes.email === "string" ? normalizeEmail(changes.email) : undefined,
    role:
      changes.role === "owner" || changes.role === "manager" || changes.role === "support"
        ? changes.role
        : undefined,
    status: typeof changes.status === "string" ? changes.status : undefined,
  });
  const dto = updated ? mapAdmin(updated) : null;
  await writeAudit({
    session,
    action: "admin.update",
    targetType: "admin",
    targetId: adminId,
    ip,
    before: mapAdmin(existing),
    after: dto,
  });
  return dto;
}

export async function deleteAdminFor(session: SessionLike, adminId: string, ip?: string) {
  requireAdmin(session);
  const existing = await findAdminById(adminId);
  if (!existing) throw accessDenied("That admin is not available.");
  if (existing.role === "owner") {
    const owners = await countActiveOwners();
    if (owners <= 1) throw conflict("Cannot delete the last owner admin.");
  }
  await softDeleteAdmin(adminId);
  await writeAudit({
    session,
    action: "admin.delete",
    targetType: "admin",
    targetId: adminId,
    ip,
    before: mapAdmin(existing),
  });
  return { id: adminId };
}

export async function adminOverview(session: SessionLike) {
  requireAdmin(session);
  const [transactions, suppliers, admins, customerCount] = await Promise.all([
    listTransactions({}),
    listSuppliers(),
    listAdmins(),
    query<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM wp_users u
       INNER JOIN wp_usermeta m ON m.user_id = u.ID AND m.meta_key = 'wp_capabilities'
       WHERE m.meta_value LIKE '%customer%'`,
    ).then((rows) => Number(rows[0]?.c || 0)),
  ]);
  const paid = transactions.filter((t) => t.status === "paid");
  return {
    revenue: centsToRands(paid.reduce((sum, t) => sum + t.total_cents, 0)),
    paidCount: paid.length,
    pendingCount: transactions.filter((t) => t.status === "pending").length,
    failedCount: transactions.filter((t) => t.status === "failed" || t.status === "refunded").length,
    customerCount,
    supplierCount: suppliers.length,
    pendingSuppliers: suppliers.filter((s) => s.status === "pending").length,
    adminCount: admins.length,
  };
}

export async function listCustomersFor(session: SessionLike): Promise<CustomerDto[]> {
  requireAdmin(session);
  const rows = await query<
    (RowDataPacket & {
      id: number;
      name: string;
      email: string;
      phone: string;
      city: string;
      created_at: Date;
      status: "active" | "blocked";
      orders: number;
      spend_cents: number;
    })[]
  >(
    `SELECT
      u.ID AS id,
      u.display_name AS name,
      u.user_email AS email,
      COALESCE(phone.meta_value, '') AS phone,
      COALESCE(city.meta_value, '') AS city,
      u.user_registered AS created_at,
      COALESCE(f.status, 'active') AS status,
      COALESCE(stats.orders, 0) AS orders,
      COALESCE(stats.spend_cents, 0) AS spend_cents
     FROM wp_users u
     LEFT JOIN iuw_customer_flags f ON f.wp_user_id = u.ID AND f.deleted_at IS NULL
     LEFT JOIN wp_usermeta phone ON phone.user_id = u.ID AND phone.meta_key = 'billing_phone'
     LEFT JOIN wp_usermeta city ON city.user_id = u.ID AND city.meta_key = 'billing_city'
     LEFT JOIN (
       SELECT customer_wp_user_id AS uid, COUNT(*) AS orders,
              SUM(CASE WHEN status = 'paid' THEN total_cents ELSE 0 END) AS spend_cents
       FROM iuw_transactions
       WHERE deleted_at IS NULL AND customer_wp_user_id IS NOT NULL
       GROUP BY customer_wp_user_id
     ) stats ON stats.uid = u.ID
     INNER JOIN wp_usermeta caps ON caps.user_id = u.ID AND caps.meta_key = 'wp_capabilities'
     WHERE caps.meta_value LIKE '%customer%'
     ORDER BY u.user_registered DESC
     LIMIT 500`,
  );

  return rows.map((row) => ({
    id: String(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    orders: Number(row.orders) || 0,
    spend: centsToRands(Number(row.spend_cents) || 0),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function updateCustomerFor(
  session: SessionLike,
  customerId: string,
  changes: { status?: "active" | "blocked"; notes?: string },
  ip?: string,
) {
  requireAdmin(session);
  if (changes.status !== "active" && changes.status !== "blocked") {
    throw validationError("status must be active or blocked");
  }
  await execute(
    `INSERT INTO iuw_customer_flags (wp_user_id, status, notes)
     VALUES (:id, :status, :notes)
     ON DUPLICATE KEY UPDATE status = VALUES(status), notes = VALUES(notes), deleted_at = NULL`,
    { id: Number(customerId), status: changes.status, notes: changes.notes || "" },
  );
  await writeAudit({
    session,
    action: "customer.update",
    targetType: "customer",
    targetId: customerId,
    ip,
    after: changes,
  });
  return { id: customerId, ...changes };
}

export async function createCustomerFor(
  session: SessionLike,
  data: { name: string; email: string; password: string; phone?: string; city?: string },
  ip?: string,
) {
  requireAdmin(session);
  const wpUser = await createWpUserViaBridge({
    email: normalizeEmail(data.email),
    password: data.password,
    displayName: data.name,
    roles: ["customer"],
  });
  await writeAudit({
    session,
    action: "customer.create",
    targetType: "customer",
    targetId: String(wpUser.wpUserId),
    ip,
    after: { email: wpUser.email, name: data.name },
  });
  return {
    id: String(wpUser.wpUserId),
    name: data.name,
    email: wpUser.email,
    phone: data.phone || "",
    city: data.city || "",
    orders: 0,
    spend: 0,
    status: "active" as const,
    createdAt: new Date().toISOString(),
  };
}

export async function deleteCustomerFor(session: SessionLike, customerId: string, ip?: string) {
  requireAdmin(session);
  await execute(
    `INSERT INTO iuw_customer_flags (wp_user_id, status, notes, deleted_at)
     VALUES (:id, 'blocked', 'soft-deleted', UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE status = 'blocked', deleted_at = UTC_TIMESTAMP(3)`,
    { id: Number(customerId) },
  );
  await writeAudit({ session, action: "customer.delete", targetType: "customer", targetId: customerId, ip });
  return { id: customerId };
}
