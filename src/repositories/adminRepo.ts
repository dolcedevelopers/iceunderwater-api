import type { RowDataPacket } from "mysql2";
import { execute, query } from "../db/pool.js";
import type { AdminRole } from "../authz/permissions.js";

export type AdminRow = RowDataPacket & {
  id: string;
  wp_user_id: number;
  name: string;
  email: string;
  role: AdminRole;
  status: string;
  created_at: Date;
  deleted_at: Date | null;
};

export async function listAdmins(): Promise<AdminRow[]> {
  return query<AdminRow[]>(`SELECT * FROM iuw_admins WHERE deleted_at IS NULL ORDER BY created_at ASC`);
}

export async function findAdminById(id: string): Promise<AdminRow | null> {
  const rows = await query<AdminRow[]>(`SELECT * FROM iuw_admins WHERE id = :id AND deleted_at IS NULL LIMIT 1`, { id });
  return rows[0] || null;
}

export async function findAdminByWpUserId(wpUserId: number): Promise<AdminRow | null> {
  const rows = await query<AdminRow[]>(
    `SELECT * FROM iuw_admins WHERE wp_user_id = :wpUserId AND deleted_at IS NULL LIMIT 1`,
    { wpUserId },
  );
  return rows[0] || null;
}

export async function countActiveOwners(): Promise<number> {
  const rows = await query<(RowDataPacket & { c: number })[]>(
    `SELECT COUNT(*) AS c FROM iuw_admins
     WHERE deleted_at IS NULL AND status = 'active' AND role = 'owner'`,
  );
  return Number(rows[0]?.c || 0);
}

export async function insertAdmin(row: {
  id: string;
  wp_user_id: number;
  name: string;
  email: string;
  role: AdminRole;
  status?: string;
}): Promise<AdminRow> {
  await execute(
    `INSERT INTO iuw_admins (id, wp_user_id, name, email, role, status)
     VALUES (:id, :wp_user_id, :name, :email, :role, :status)`,
    { status: "active", ...row },
  );
  const created = await findAdminById(row.id);
  if (!created) throw new Error("admin insert failed");
  return created;
}

export async function updateAdmin(
  id: string,
  changes: Partial<{ name: string; email: string; role: AdminRole; status: string }>,
): Promise<AdminRow | null> {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    fields.push(`${key} = :${key}`);
    params[key] = value;
  }
  if (!fields.length) return findAdminById(id);
  await execute(`UPDATE iuw_admins SET ${fields.join(", ")} WHERE id = :id AND deleted_at IS NULL`, params);
  return findAdminById(id);
}

export async function softDeleteAdmin(id: string): Promise<void> {
  await execute(`UPDATE iuw_admins SET deleted_at = UTC_TIMESTAMP(3) WHERE id = :id AND deleted_at IS NULL`, { id });
}
