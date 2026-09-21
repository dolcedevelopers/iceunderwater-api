import type { RowDataPacket } from "mysql2";
import { execute, query } from "../db/pool.js";

export type SupplierRow = RowDataPacket & {
  id: string;
  wp_user_id: number | null;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  city: string;
  province: string;
  /** Legal identity printed on generated invoices. */
  vat_number: string;
  registration_number: string;
  address: string;
  logo_url: string;
  status: "active" | "pending" | "suspended";
  markup_percent: number;
  created_at: Date;
  deleted_at: Date | null;
};

export async function listSuppliers(filter?: {
  id?: string;
  status?: string;
  city?: string;
  province?: string;
}): Promise<SupplierRow[]> {
  const clauses = ["deleted_at IS NULL"];
  const params: Record<string, unknown> = {};
  if (filter?.id) {
    clauses.push("id = :id");
    params.id = filter.id;
  }
  if (filter?.status) {
    clauses.push("status = :status");
    params.status = filter.status;
  }
  if (filter?.city) {
    clauses.push("LOWER(city) = LOWER(:city)");
    params.city = filter.city;
  }
  if (filter?.province) {
    clauses.push("LOWER(province) = LOWER(:province)");
    params.province = filter.province;
  }
  return query<SupplierRow[]>(
    `SELECT * FROM iuw_suppliers WHERE ${clauses.join(" AND ")} ORDER BY city ASC, name ASC`,
    params,
  );
}

export async function findSupplierById(id: string): Promise<SupplierRow | null> {
  const rows = await query<SupplierRow[]>(
    `SELECT * FROM iuw_suppliers WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

export async function findSupplierByWpUserId(wpUserId: number): Promise<SupplierRow | null> {
  const rows = await query<SupplierRow[]>(
    `SELECT * FROM iuw_suppliers WHERE wp_user_id = :wpUserId AND deleted_at IS NULL LIMIT 1`,
    { wpUserId },
  );
  return rows[0] || null;
}

export async function insertSupplier(row: {
  id: string;
  wp_user_id: number | null;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  city: string;
  province?: string;
  vat_number?: string;
  registration_number?: string;
  address?: string;
  logo_url?: string;
  status: SupplierRow["status"];
}): Promise<SupplierRow> {
  await execute(
    `INSERT INTO iuw_suppliers
      (id, wp_user_id, name, contact_name, email, phone, city, province,
       vat_number, registration_number, address, logo_url, status)
     VALUES
      (:id, :wp_user_id, :name, :contact_name, :email, :phone, :city, :province,
       :vat_number, :registration_number, :address, :logo_url, :status)`,
    { logo_url: "", province: "", vat_number: "", registration_number: "", address: "", ...row },
  );
  const created = await findSupplierById(row.id);
  if (!created) throw new Error("supplier insert failed");
  return created;
}

export async function updateSupplier(
  id: string,
  changes: Partial<{
    name: string;
    contact_name: string;
    email: string;
    phone: string;
    city: string;
    province: string;
    vat_number: string;
    registration_number: string;
    address: string;
    logo_url: string;
    status: SupplierRow["status"];
    markup_percent: number;
    wp_user_id: number;
  }>,
): Promise<SupplierRow | null> {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    fields.push(`${key} = :${key}`);
    params[key] = value;
  }
  if (!fields.length) return findSupplierById(id);
  await execute(`UPDATE iuw_suppliers SET ${fields.join(", ")} WHERE id = :id AND deleted_at IS NULL`, params);
  return findSupplierById(id);
}

export async function softDeleteSupplier(id: string): Promise<void> {
  await execute(`UPDATE iuw_suppliers SET deleted_at = UTC_TIMESTAMP(3) WHERE id = :id AND deleted_at IS NULL`, { id });
}
