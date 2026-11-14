import { accessDenied, conflict, validationError } from "./errors.js";
import { isAdmin, isDriver, isSupplier, requireSignedIn, type SessionLike } from "../authz/permissions.js";
export type DeliveryAction = "start" | "decline" | "arrive" | "not-collected" | "receive" | "redeliver" | "reassign";
export type DeliveryState = { status: string; driver_id: string; supplier_id: string; customer_wp_user_id: number | null; customer_email: string; collect_by?: Date | null };
export function ownsDelivery(session: SessionLike, row: DeliveryState) {
  return Boolean(session?.wpUserId && Number(row.customer_wp_user_id) === session.wpUserId);
}
export function checkDeliveryAccess(session: SessionLike, row: DeliveryState) {
  requireSignedIn(session);
  if (!isAdmin(session) && !(isSupplier(session) && session!.supplierId === row.supplier_id) && !(isDriver(session) && session!.driverId === row.driver_id) && !ownsDelivery(session,row)) throw accessDenied("That delivery is not available.");
}
export function deliveryTransition(session: SessionLike, row: DeliveryState, action: DeliveryAction, now: Date) {
  checkDeliveryAccess(session,row);
  const driver = isDriver(session) && session!.driverId === row.driver_id;
  const customer = !isDriver(session) && ownsDelivery(session,row);
  const manager = isAdmin(session) || (isSupplier(session) && session!.supplierId === row.supplier_id);
  const expired = row.status === "arrived" && row.collect_by && row.collect_by.getTime() <= now.getTime();
  if (["start","decline","arrive","not-collected"].includes(action) && !driver) throw accessDenied("Only the assigned driver can perform this action.");
  if (["receive","redeliver"].includes(action) && !customer) throw accessDenied("Only the purchasing customer can perform this action.");
  if (action === "reassign" && !manager) throw accessDenied();
  if (action === "start" && row.status === "assigned") return "en-route";
  if (action === "decline" && row.status === "assigned") return "declined";
  if (action === "arrive" && ["en-route","nearby"].includes(row.status)) return "arrived";
  if (action === "not-collected" && expired) return "not_delivered";
  if (action === "not-collected" && row.status === "arrived") throw validationError("Wait until the 20-minute collection window has ended.");
  if (action === "receive" && row.status === "arrived" && !expired) return "delivered";
  if (action === "redeliver" && (row.status === "not_delivered" || expired)) return "redelivery_requested";
  if (action === "reassign" && ["declined","redelivery_requested"].includes(row.status)) return "assigned";
  throw conflict("This delivery has changed. Refresh to see its current status.");
}
