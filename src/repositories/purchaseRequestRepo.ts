import type { PoolConnection } from "mysql2/promise";
import type { SupplierRow } from "./supplierRepo.js";
import type { RequestLocation } from "../lib/serviceArea.js";
import type { RowDataPacket } from "mysql2";
import { execute, query, withTransaction } from "../db/pool.js";
import { accessDenied, conflict, notFound } from "../lib/errors.js";

export type PurchaseRequestStatus =
  | "open"
  | "accepted"
  | "checkout_started"
  | "paid"
  | "cancelled"
  | "expired";

export type PurchaseRequestRow = RowDataPacket & {
  id: string;
  customer_wp_user_id: number;
  customer_email: string;
  /** Set when the buyer is itself a company ordering from another company. */
  requester_supplier_id: string | null;
  target_supplier_id: string | null;
  wc_product_id: number;
  product_name: string;
  qty: number;
  status: PurchaseRequestStatus;
  accepted_supplier_id: string | null;
  woo_order_id: number | null;
  woo_order_number: string | null;
  checkout_url: string;
  expires_at: Date | null;
  resend_count: number;
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
  paid_at: Date | null;
  delivery_status?: string | null;
  delivery_at?: Date | null;
  fulfilment_type?: "delivery" | "pickup" | null;
  refund_status?: "sending" | "sent" | "failed" | null;
  refund_reason?: string | null;
  refund_requested_at?: Date | null;
  supplier_contact_name?: string | null;
  supplier_contact_email?: string | null;
  supplier_contact_phone?: string | null;
  supplier_contact_address?: string | null;
  location_province?: string | null;
  location_city?: string | null;
  location_address?: string | null;
  location_latitude?: number | string | null;
  location_longitude?: number | string | null;
};

export type PurchaseOfferRow = RowDataPacket & {
  id: number;
  request_id: string;
  supplier_id: string;
  status: "notified" | "accepted" | "missed" | "declined";
  created_at: Date;
};

function acceptWindowMinutes(value: number): number {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes)) return 15;
  return Math.min(120, Math.max(1, minutes));
}

export async function insertPurchaseRequest(row: {
  id: string;
  customer_wp_user_id: number;
  customer_email: string;
  requester_supplier_id: string | null;
  target_supplier_id: string | null;
  wc_product_id: number;
  product_name: string;
  qty: number;
  window_minutes: number;
  delivery_at: Date;
  location: RequestLocation;
}): Promise<PurchaseRequestRow> {
  const windowMinutes = acceptWindowMinutes(row.window_minutes);
  // INTERVAL cannot take a bound parameter on this driver, so the window is inlined after clamping.
  await execute(
    `INSERT INTO iuw_purchase_requests
      (id, customer_wp_user_id, customer_email, requester_supplier_id, target_supplier_id,
       wc_product_id, product_name, qty, delivery_at, fulfilment_type, location_address, location_province, location_city, status, expires_at)
     VALUES
      (:id, :customer_wp_user_id, :customer_email, :requester_supplier_id, :target_supplier_id,
       :wc_product_id, :product_name, :qty, :delivery_at, :fulfilmentType, :locationAddress, :province, :city, 'open',
       LEAST(:delivery_at, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${windowMinutes} MINUTE)))`,
    { ...row, fulfilmentType: row.location.fulfilmentType, locationAddress: row.location.address, province: row.location.province, city: row.location.city },
  );
  const created = await findPurchaseRequestById(row.id);
  if (!created) throw new Error("purchase request insert failed");
  return created;
}

/**
 * Flip lapsed requests to `expired` before anything reads or accepts them, so
 * the stored status is the truth and no caller has to re-derive it.
 */
export async function expireStalePurchaseRequests(): Promise<void> {
  await execute(
    `UPDATE iuw_purchase_requests
        SET status = 'expired'
      WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP(3)`,
  );
}

/**
 * Requester amends the quantity and puts the request back in front of
 * companies. Offers are reset so everyone gets a fresh look at it.
 */
export async function resendPurchaseRequest(input: {
  requestId: string;
  qty: number;
  windowMinutes: number;
  deliveryAt: Date;
  location?: RequestLocation;
  targetSupplierId: string | null;
  supplierIds: string[];
}): Promise<PurchaseRequestRow> {
  const windowMinutes = acceptWindowMinutes(input.windowMinutes);
  return withTransaction(async (conn) => {
  const [locked] = await conn.query<PurchaseRequestRow[]>(
    `SELECT * FROM iuw_purchase_requests WHERE id = ? FOR UPDATE`, [input.requestId],
  );
  if (!locked[0] || !["open", "expired"].includes(locked[0].status)) {
    throw conflict("This request can no longer be changed.");
  }
  await conn.query(
    `UPDATE iuw_purchase_requests
        SET qty = :qty,
            delivery_at = :deliveryAt,
            fulfilment_type = :fulfilmentType,
            location_address = :locationAddress,
            location_province = :province,
            location_city = :city,
            target_supplier_id = :targetSupplierId,
            status = 'open',
            accepted_supplier_id = NULL,
            accepted_at = NULL,
            checkout_url = '',
            resend_count = resend_count + 1,
            expires_at = LEAST(:deliveryAt, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${windowMinutes} MINUTE))
      WHERE id = :requestId AND status IN ('open', 'expired')`,
    { ...input, fulfilmentType: input.location?.fulfilmentType ?? locked[0].fulfilment_type,
      locationAddress: input.location?.address ?? locked[0].location_address,
      province: input.location?.province ?? locked[0].location_province,
      city: input.location?.city ?? locked[0].location_city },
  );
  await conn.query(`DELETE FROM iuw_purchase_request_offers WHERE request_id = :requestId`, {
    requestId: input.requestId,
  });
  for (const supplierId of input.supplierIds) {
    await conn.execute(
      `INSERT INTO iuw_purchase_request_offers (request_id, supplier_id, status) VALUES (?, ?, 'notified')`,
      [input.requestId, supplierId],
    );
  }
  const [updated] = await conn.query<PurchaseRequestRow[]>(
    `SELECT * FROM iuw_purchase_requests WHERE id = ?`, [input.requestId],
  );
  return updated[0]!;
  });
}

export async function insertPurchaseOffers(requestId: string, supplierIds: string[]): Promise<void> {
  for (const supplierId of supplierIds) {
    await execute(
      `INSERT IGNORE INTO iuw_purchase_request_offers (request_id, supplier_id, status)
       VALUES (:requestId, :supplierId, 'notified')`,
      { requestId, supplierId },
    );
  }
}

const supplierContactSql = `
  (SELECT name FROM iuw_suppliers WHERE id = r.accepted_supplier_id) AS supplier_contact_name,
  (SELECT email FROM iuw_suppliers WHERE id = r.accepted_supplier_id) AS supplier_contact_email,
  (SELECT phone FROM iuw_suppliers WHERE id = r.accepted_supplier_id) AS supplier_contact_phone,
  (SELECT address FROM iuw_suppliers WHERE id = r.accepted_supplier_id) AS supplier_contact_address`;

export async function findPurchaseRequestById(id: string): Promise<PurchaseRequestRow | null> {
  const rows = await query<PurchaseRequestRow[]>(
    `SELECT r.*, ${supplierContactSql}, (SELECT d.status FROM iuw_deliveries d
       WHERE d.wc_order_id = r.woo_order_id AND d.supplier_id = r.accepted_supplier_id
         AND d.deleted_at IS NULL ORDER BY d.assigned_at DESC LIMIT 1) AS delivery_status
     FROM iuw_purchase_requests r WHERE id = :id LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

export async function listPurchaseRequests(filter: {
  customerWpUserId?: number;
  supplierId?: string;
  status?: string;
}): Promise<PurchaseRequestRow[]> {
  const clauses: string[] = ["1=1"];
  const params: Record<string, unknown> = {};
  if (filter.customerWpUserId) {
    clauses.push("customer_wp_user_id = :customerWpUserId");
    params.customerWpUserId = filter.customerWpUserId;
  }
  if (filter.status) {
    clauses.push("status = :status");
    params.status = filter.status;
  }
  if (filter.supplierId) {
    // A company sees requests it was offered, ones it accepted, and its own
    // orders placed with other companies.
    clauses.push(
      `(accepted_supplier_id = :supplierId
        OR requester_supplier_id = :supplierId
        OR id IN (
         SELECT request_id FROM iuw_purchase_request_offers WHERE supplier_id = :supplierId
       ))`,
    );
    params.supplierId = filter.supplierId;
  }
  return query<PurchaseRequestRow[]>(
    `SELECT r.*, ${supplierContactSql}, (SELECT d.status FROM iuw_deliveries d
       WHERE d.wc_order_id = r.woo_order_id AND d.supplier_id = r.accepted_supplier_id
         AND d.deleted_at IS NULL ORDER BY d.assigned_at DESC LIMIT 1) AS delivery_status
     FROM iuw_purchase_requests r WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
    params,
  );
}

export async function acceptPurchaseRequest(
  requestId: string,
  supplierId: string,
  checkoutUrlFor: (row: PurchaseRequestRow) => string,
  validateFulfilment?: (row: PurchaseRequestRow, supplier: SupplierRow, connection: PoolConnection) => Promise<void>,
): Promise<PurchaseRequestRow> {
  return withTransaction(async (conn) => {
    // Expiry is evaluated by the database so it cannot drift with server clocks.
    const [rows] = await conn.query<(PurchaseRequestRow & { is_expired: number })[]>(
      `SELECT *, (expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP(3)) AS is_expired
         FROM iuw_purchase_requests WHERE id = ? FOR UPDATE`,
      [requestId],
    );
    const row = rows[0];
    if (!row) throw notFound("That request is not available.");
    if (row.requester_supplier_id && row.requester_supplier_id === supplierId) {
      throw conflict("You cannot accept your own order.");
    }
    if (row.status !== "open") throw conflict("Another company already accepted this request.");
    if (Number(row.is_expired)) {
      await conn.query(`UPDATE iuw_purchase_requests SET status = 'expired' WHERE id = ? AND status = 'open'`, [
        requestId,
      ]);
      throw conflict("This request expired before it was accepted.");
    }

    const [offers] = await conn.query<PurchaseOfferRow[]>(
      `SELECT * FROM iuw_purchase_request_offers WHERE request_id = ? AND supplier_id = ? LIMIT 1`,
      [requestId, supplierId],
    );
    if (!offers[0]) throw notFound("You were not offered this request.");
    const [suppliers] = await conn.query<SupplierRow[]>(
      `SELECT * FROM iuw_suppliers WHERE id = ? AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
      [supplierId],
    );
    if (!suppliers[0] || (row.target_supplier_id && row.target_supplier_id !== supplierId)) {
      throw conflict("This supplier cannot accept this request.");
    }

    await validateFulfilment?.(row, suppliers[0], conn);

    await conn.query(
      `UPDATE iuw_purchase_requests
       SET status = 'accepted', accepted_supplier_id = ?, checkout_url = ?, accepted_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND status = 'open'`,
      [supplierId, checkoutUrlFor(row), requestId],
    );
    await conn.query(
      `UPDATE iuw_purchase_request_offers SET status = 'accepted' WHERE request_id = ? AND supplier_id = ?`,
      [requestId, supplierId],
    );
    await conn.query(
      `UPDATE iuw_purchase_request_offers SET status = 'missed'
       WHERE request_id = ? AND supplier_id <> ? AND status = 'notified'`,
      [requestId, supplierId],
    );

    const [updated] = await conn.query<PurchaseRequestRow[]>(
      `SELECT * FROM iuw_purchase_requests WHERE id = ? LIMIT 1`,
      [requestId],
    );
    return updated[0]!;
  });
}

export async function markPurchaseRequestPaid(input: {
  requestId: string;
  customerWpUserId: number;
  wooOrderId: number;
  wooOrderNumber: string;
}): Promise<boolean> {
  const result = await execute(
    `UPDATE iuw_purchase_requests
     SET status = 'paid', woo_order_id = :wooOrderId, woo_order_number = :wooOrderNumber, paid_at = UTC_TIMESTAMP(3)
     WHERE id = :requestId
       AND customer_wp_user_id = :customerWpUserId
       AND accepted_supplier_id IS NOT NULL
       AND status IN ('accepted', 'checkout_started')`,
    input,
  );
  return Boolean(result.affectedRows);
}

/** Serializes checkout with cancellation so a cancelled request cannot issue a payment link. */
export async function markCheckoutStarted(requestId: string): Promise<PurchaseRequestRow> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<PurchaseRequestRow[]>("SELECT * FROM iuw_purchase_requests WHERE id = ? FOR UPDATE", [requestId]);
    const row = rows[0];
    if (!row) throw notFound("That request is not available.");
    if (!row.accepted_supplier_id || !["accepted", "checkout_started"].includes(row.status)) throw conflict("This request can no longer be paid.");
    await conn.query("UPDATE iuw_purchase_requests SET status = 'checkout_started' WHERE id = ? AND status = 'accepted'", [requestId]);
    return { ...row, status: "checkout_started" };
  });
}

export async function cancelPurchaseRequest(requestId: string, owner: { customerWpUserId: number; supplierId: string | null }): Promise<PurchaseRequestRow> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<PurchaseRequestRow[]>("SELECT * FROM iuw_purchase_requests WHERE id = ? FOR UPDATE", [requestId]);
    const row = rows[0];
    if (!row) throw notFound("That request is not available.");
    if (owner.supplierId ? row.requester_supplier_id !== owner.supplierId
      : row.requester_supplier_id != null || Number(row.customer_wp_user_id) !== owner.customerWpUserId) throw accessDenied();
    if (row.status === "cancelled") return row;
    if (!["open", "expired", "accepted"].includes(row.status) || row.woo_order_id != null || row.paid_at != null) {
      throw conflict("Payment has already started or this order is paid. Contact your supplier to arrange cancellation.");
    }
    await conn.query("UPDATE iuw_purchase_requests SET status = 'cancelled', checkout_url = '', expires_at = NULL WHERE id = ?", [requestId]);
    await conn.query("UPDATE iuw_purchase_request_offers SET status = 'missed' WHERE request_id = ? AND status IN ('notified', 'accepted')", [requestId]);
    return { ...row, status: "cancelled", checkout_url: "", expires_at: null };
  });
}
