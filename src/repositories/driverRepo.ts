import type { RowDataPacket } from "mysql2";
import { execute, query } from "../db/pool.js";

export type DriverRow = RowDataPacket & {
  id: string;
  supplier_id: string;
  name: string;
  phone: string;
  email: string;
  vehicle: string;
  registration: string;
  licence: string;
  status: "available" | "on-delivery" | "off-duty";
  active: number;
  password_hash: string | null;
  created_at: Date;
  deleted_at: Date | null;
};

export async function listDrivers(supplierId?: string | null): Promise<DriverRow[]> {
  if (supplierId) {
    return query<DriverRow[]>(
      `SELECT * FROM iuw_drivers WHERE supplier_id = :supplierId AND deleted_at IS NULL ORDER BY name ASC`,
      { supplierId },
    );
  }
  return query<DriverRow[]>(`SELECT * FROM iuw_drivers WHERE deleted_at IS NULL ORDER BY name ASC`);
}

export async function findDriverById(id: string): Promise<DriverRow | null> {
  const rows = await query<DriverRow[]>(`SELECT * FROM iuw_drivers WHERE id = :id AND deleted_at IS NULL LIMIT 1`, {
    id,
  });
  return rows[0] || null;
}

export async function findDriverByEmail(email: string): Promise<DriverRow | null> {
  const rows = await query<DriverRow[]>(
    `SELECT * FROM iuw_drivers WHERE email = :email AND deleted_at IS NULL LIMIT 1`,
    { email },
  );
  return rows[0] || null;
}

export async function insertDriver(row: {
  id: string;
  supplier_id: string;
  name: string;
  phone: string;
  email: string;
  vehicle: string;
  registration: string;
  licence: string;
  status?: DriverRow["status"];
  active?: boolean;
  password_hash?: string | null;
}): Promise<DriverRow> {
  await execute(
    `INSERT INTO iuw_drivers
      (id, supplier_id, name, phone, email, vehicle, registration, licence, status, active, password_hash)
     VALUES
      (:id, :supplier_id, :name, :phone, :email, :vehicle, :registration, :licence, :status, :active, :password_hash)`,
    {
      status: "available",
      password_hash: null,
      ...row,
      active: row.active === false ? 0 : 1,
    },
  );
  const created = await findDriverById(row.id);
  if (!created) throw new Error("driver insert failed");
  return created;
}

export async function updateDriver(
  id: string,
  changes: Partial<{
    name: string;
    phone: string;
    email: string;
    vehicle: string;
    registration: string;
    licence: string;
    status: DriverRow["status"];
    active: boolean;
    password_hash: string;
  }>,
): Promise<DriverRow | null> {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (key === "active") {
      fields.push("active = :active");
      params.active = value ? 1 : 0;
      continue;
    }
    fields.push(`${key} = :${key}`);
    params[key] = value;
  }
  if (!fields.length) return findDriverById(id);
  await execute(`UPDATE iuw_drivers SET ${fields.join(", ")} WHERE id = :id AND deleted_at IS NULL`, params);
  return findDriverById(id);
}

export async function softDeleteDriver(id: string): Promise<void> {
  await execute(`UPDATE iuw_drivers SET deleted_at = UTC_TIMESTAMP(3) WHERE id = :id AND deleted_at IS NULL`, { id });
}

export async function insertDriverPing(row: {
  driver_id: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}): Promise<void> {
  await execute(
    `INSERT INTO iuw_driver_pings (driver_id, lat, lng, accuracy, heading, speed)
     VALUES (:driver_id, :lat, :lng, :accuracy, :heading, :speed)`,
    {
      accuracy: null,
      heading: null,
      speed: null,
      ...row,
    },
  );
}

export async function latestDriverPing(driverId: string): Promise<{
  lat: number;
  lng: number;
  recorded_at: Date;
} | null> {
  const rows = await query<(RowDataPacket & { lat: number; lng: number; recorded_at: Date })[]>(
    `SELECT lat, lng, recorded_at FROM iuw_driver_pings
     WHERE driver_id = :driverId ORDER BY recorded_at DESC LIMIT 1`,
    { driverId },
  );
  return rows[0] || null;
}
