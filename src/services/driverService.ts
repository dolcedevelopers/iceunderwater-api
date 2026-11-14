import { deliveryAction, deliveriesFor } from "./deliveryWorkflowService.js";
import {
  assertOwnsRecord,
  isAdmin,
  isCustomer,
  isDriver,
  isSupplier,
  requireRole,
  resolveSupplierScope,
  type SessionLike,
  ROLES,
  identityEmail,
} from "../authz/permissions.js";
import { accessDenied, validationError } from "../lib/errors.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { hashPassword } from "../auth/password.js";
import { query } from "../db/pool.js";
import type { RowDataPacket } from "mysql2";
import { mapDriver } from "../serializers/dto.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  findDriverById,
  insertDriver,
  insertDriverPing,
  latestDriverPing,
  listDrivers,
  softDeleteDriver,
  updateDriver,
} from "../repositories/driverRepo.js";
import { findActiveDeliveryForDriverCustomer, findDeliveryById, insertDelivery, listDeliveries, updateDeliveryStatus } from "../repositories/deliveryRepo.js";
import { findTransactionByOrderId } from "../repositories/transactionRepo.js";

export async function listDriversFor(session: SessionLike, supplierId?: string) {
  const scope = resolveSupplierScope(session, supplierId);
  return (await listDrivers(scope)).map(mapDriver);
}

export async function createDriverFor(
  session: SessionLike,
  supplierId: string | undefined,
  data: {
    name: string;
    phone?: string;
    email?: string;
    vehicle?: string;
    registration?: string;
    licence?: string;
    status?: "available" | "on-delivery" | "off-duty";
    active?: boolean;
    password?: string;
  },
  ip?: string,
) {
  const scope = resolveSupplierScope(session, supplierId);
  if (!scope) throw accessDenied("Choose which supplier this driver belongs to.");
  if (!data.name?.trim()) throw validationError("Driver name is required.");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email||"") || (data.phone||"").replace(/\D/g,"").length<6 || (data.password||"").length<8) throw validationError("Enter a valid driver email, phone number and an app password of at least eight characters.");
  const row = await insertDriver({
    id: makeId("drv"),
    supplier_id: scope,
    name: data.name.trim(),
    phone: data.phone?.trim() || "",
    email: normalizeEmail(data.email || ""),
    vehicle: data.vehicle?.trim() || "",
    registration: data.registration?.trim() || "",
    licence: data.licence?.trim() || "",
    status: data.status,
    active: data.active,
    password_hash: data.password ? await hashPassword(data.password) : null,
  });
  const dto = mapDriver(row);
  await writeAudit({ session, action: "driver.create", targetType: "driver", targetId: row.id, ip, after: dto });
  return dto;
}

export async function updateDriverFor(
  session: SessionLike,
  driverId: string,
  changes: Record<string, unknown>,
  ip?: string,
) {
  const existing = await findDriverById(driverId);
  assertOwnsRecord(session, existing ? { supplierId: existing.supplier_id } : null, "driver");
  if(typeof changes.phone==="string" && changes.phone.replace(/\D/g,"").length<6)throw validationError("Enter a valid driver phone number.");
  if(typeof changes.email==="string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email))throw validationError("Enter a valid driver email.");
  if(changes.status==="available" || changes.active===false) {
    const runs=await query<RowDataPacket[]>("SELECT id FROM iuw_deliveries WHERE driver_id=:id AND deleted_at IS NULL AND status IN ('assigned','en-route','nearby','arrived') LIMIT 1",{id:driverId});
    if(runs.length)throw validationError("This driver still has an active delivery. Complete or resolve it before changing availability.");
  }
  const updated = await updateDriver(driverId, {
    name: typeof changes.name === "string" ? changes.name : undefined,
    phone: typeof changes.phone === "string" ? changes.phone : undefined,
    email: typeof changes.email === "string" ? normalizeEmail(changes.email) : undefined,
    vehicle: typeof changes.vehicle === "string" ? changes.vehicle : undefined,
    registration: typeof changes.registration === "string" ? changes.registration : undefined,
    licence: typeof changes.licence === "string" ? changes.licence : undefined,
    status:
      changes.status === "available" || changes.status === "on-delivery" || changes.status === "off-duty"
        ? changes.status
        : undefined,
    active: typeof changes.active === "boolean" ? changes.active : undefined,
    password_hash: typeof changes.password === "string" ? await hashPassword(changes.password) : undefined,
  });
  const dto = updated ? mapDriver(updated) : null;
  await writeAudit({ session, action: "driver.update", targetType: "driver", targetId: driverId, ip, after: dto });
  return dto;
}

export async function deleteDriverFor(session: SessionLike, driverId: string, ip?: string) {
  const existing = await findDriverById(driverId);
  assertOwnsRecord(session, existing ? { supplierId: existing.supplier_id } : null, "driver");
  const runs=await query<RowDataPacket[]>("SELECT id FROM iuw_deliveries WHERE driver_id=:id AND deleted_at IS NULL AND status IN ('assigned','en-route','nearby','arrived') LIMIT 1",{id:driverId});
  if(runs.length)throw validationError("This driver still has an active delivery and cannot be removed.");
  await softDeleteDriver(driverId);
  await writeAudit({ session, action: "driver.delete", targetType: "driver", targetId: driverId, ip });
  return { id: driverId };
}

export async function postDriverPing(
  session: SessionLike,
  driverId: string,
  ping: { lat: number; lng: number; accuracy?: number; heading?: number; speed?: number },
) {
  requireRole(session, ROLES.DRIVER);
  if (!isDriver(session) || session?.driverId !== driverId) {
    throw accessDenied("You can only post your own location.");
  }
  if (!Number.isFinite(ping.lat) || !Number.isFinite(ping.lng)) {
    throw validationError("Invalid coordinates.");
  }
  if (Math.abs(ping.lat) > 90 || Math.abs(ping.lng) > 180) {
    throw validationError("Coordinates out of range.");
  }

  const previous = await latestDriverPing(driverId);
  if (previous) {
    const jumpKm = haversineKm(previous.lat, previous.lng, ping.lat, ping.lng);
    const elapsedMin = (Date.now() - new Date(previous.recorded_at).getTime()) / 60_000;
    if (elapsedMin < 5 && jumpKm > 80) {
      throw validationError("Implausible location jump rejected.");
    }
  }

  await insertDriverPing({
    driver_id: driverId,
    lat: ping.lat,
    lng: ping.lng,
    accuracy: ping.accuracy,
    heading: ping.heading,
    speed: ping.speed,
  });
  return { ok: true };
}

export async function trackDriver(session: SessionLike, driverId: string) {
  const driver = await findDriverById(driverId);
  if (!driver) throw accessDenied("That driver is not available.");

  if (isAdmin(session) || (isSupplier(session) && session?.supplierId === driver.supplier_id)) {
    const ping = await latestDriverPing(driverId);
    return {
      driverId,
      lat: ping?.lat ?? null,
      lng: ping?.lng ?? null,
      recordedAt: ping?.recorded_at ? new Date(ping.recorded_at).toISOString() : null,
      precision: "full" as const,
    };
  }

  if (isCustomer(session) || isSupplier(session)) {
    const active = await findActiveDeliveryForDriverCustomer(driverId, {
      wpUserId: session!.wpUserId,
      email: identityEmail(session),
    });
    if (!active) throw accessDenied("That driver is not available.");
    const ping = await latestDriverPing(driverId);
    return {
      driverId,
      lat: ping ? Number(ping.lat.toFixed(3)) : null,
      lng: ping ? Number(ping.lng.toFixed(3)) : null,
      etaMinutes: active.eta_minutes,
      recordedAt: ping?.recorded_at ? new Date(ping.recorded_at).toISOString() : null,
      precision: "coarse" as const,
    };
  }

  throw accessDenied("That driver is not available.");
}

export async function listDeliveriesFor(session: SessionLike) { return deliveriesFor(session); }

export async function assignDelivery(
  session: SessionLike,
  data: { driverId: string; orderId: number; customerEmail?: string; customerWpUserId?: number },
  ip?: string,
) {
  requireRole(session, ROLES.ADMIN, ROLES.SUPPLIER);
  const driver = await findDriverById(data.driverId);
  assertOwnsRecord(session, driver ? { supplierId: driver.supplier_id } : null, "driver");
  const transaction = await findTransactionByOrderId(data.orderId);
  if (!transaction || transaction.supplier_id !== driver!.supplier_id) {
    throw accessDenied("That order is not available for this supplier.");
  }
  if (transaction.status !== "paid") throw validationError("Payment must be confirmed before delivery is assigned.");
  const delivery = await insertDelivery({
    id: makeId("del"),
    supplier_id: driver!.supplier_id,
    driver_id: driver!.id,
    wc_order_id: data.orderId,
    customer_wp_user_id: transaction.customer_wp_user_id,
    customer_email: transaction.customer_email,
  });
  await writeAudit({
    session,
    action: "delivery.assign",
    targetType: "delivery",
    targetId: delivery.id,
    ip,
    after: delivery,
  });
  return delivery;
}

export async function patchDelivery(session: SessionLike, deliveryId: string, status: string, ip?: string) {
  if (status !== "en-route") throw validationError("Use the delivery actions. Only the purchasing customer can confirm receipt.");
  return deliveryAction(session,deliveryId,"start");
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
