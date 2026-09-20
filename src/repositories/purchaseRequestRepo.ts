import type { RowDataPacket } from "mysql2";
import { execute, query, withTransaction } from "../db/pool.js";
import { conflict, notFound } from "../lib/errors.js";

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
  wc_product_id: number;
  product_name: string;
  qty: number;
  status: PurchaseRequestStatus;
  accepted_supplier_id: string | null;
  woo_order_id: number | null;
  woo_order_number: string | null;
  checkout_url: string;
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
  paid_at: Date | null;
};

export type PurchaseOfferRow = RowDataPacket & {
  id: number;
  request_id: string;
  supplier_id: string;
  status: "notified" | "accepted" | "missed" | "declined";
  created_at: Date;
};

export async function insertPurchaseRequest(row: {
  id: string;
  customer_wp_user_id: number;
  customer_email: string;
  wc_product_id: number;
  product_name: string;
  qty: number;
}): Promise<PurchaseRequestRow> {
  await execute(
    `INSERT INTO iuw_purchase_requests
      (id, customer_wp_user_id, customer_email, wc_product_id, product_name, qty, status)
     VALUES
      (:id, :customer_wp_user_id, :customer_email, :wc_product_id, :product_name, :qty, 'open')`,
    row,
  );
  const created = await findPurchaseRequestById(row.id);
  if (!created) throw new Error("purchase request insert failed");
  return created;
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

export async function findPurchaseRequestById(id: string): Promise<PurchaseRequestRow | null> {
  const rows = await query<PurchaseRequestRow[]>(
    `SELECT * FROM iuw_purchase_requests WHERE id = :id LIMIT 1`,
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
    clauses.push(
      `(accepted_supplier_id = :supplierId OR id IN (
         SELECT request_id FROM iuw_purchase_request_offers WHERE supplier_id = :supplierId
       ))`,
    );
    params.supplierId = filter.supplierId;
  }
  return query<PurchaseRequestRow[]>(
    `SELECT * FROM iuw_purchase_requests WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
    params,
  );
}

export async function acceptPurchaseRequest(
  requestId: string,
  supplierId: string,
  checkoutUrl: string,
): Promise<PurchaseRequestRow> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<PurchaseRequestRow[]>(
      `SELECT * FROM iuw_purchase_requests WHERE id = ? FOR UPDATE`,
      [requestId],
    );
    const row = rows[0];
    if (!row) throw notFound("That request is not available.");
    if (row.status !== "open") throw conflict("Another company already accepted this request.");

    const [offers] = await conn.query<PurchaseOfferRow[]>(
      `SELECT * FROM iuw_purchase_request_offers WHERE request_id = ? AND supplier_id = ? LIMIT 1`,
      [requestId, supplierId],
    );
    if (!offers[0]) throw notFound("You were not offered this request.");

    await conn.query(
      `UPDATE iuw_purchase_requests
       SET status = 'accepted', accepted_supplier_id = ?, checkout_url = ?, accepted_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND status = 'open'`,
      [supplierId, checkoutUrl, requestId],
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
       AND status IN ('accepted', 'checkout_started', 'open')`,
    input,
  );
  return Boolean(result.affectedRows);
}

export async function markCheckoutStarted(requestId: string): Promise<void> {
  await execute(
    `UPDATE iuw_purchase_requests SET status = 'checkout_started'
     WHERE id = :requestId AND status = 'accepted'`,
    { requestId },
  );
}
