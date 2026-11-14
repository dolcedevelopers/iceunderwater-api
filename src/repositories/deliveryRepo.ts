import { conflict, validationError } from "../lib/errors.js";
import { enqueueDeliveryNotice } from "../services/deliveryWorkflowService.js";
import type { RowDataPacket } from "mysql2";
import { execute, query, withTransaction } from "../db/pool.js";

export type DeliveryRow = RowDataPacket & {
  id: string;
  supplier_id: string;
  driver_id: string;
  wc_order_id: number;
  customer_wp_user_id: number | null;
  customer_email: string;
  status: string;
  eta_minutes: number | null;
  assigned_at: Date;
  delivered_at: Date | null;
  deleted_at: Date | null;
};

export async function listDeliveries(filter: {
  supplierId?: string | null;
  driverId?: string;
  customerWpUserId?: number;
  customerEmail?: string;
}): Promise<DeliveryRow[]> {
  const clauses = ["deleted_at IS NULL"];
  const params: Record<string, unknown> = {};
  if (filter.supplierId) {
    clauses.push("supplier_id = :supplierId");
    params.supplierId = filter.supplierId;
  }
  if (filter.driverId) {
    clauses.push("driver_id = :driverId");
    params.driverId = filter.driverId;
  }
  if (filter.customerWpUserId) {
    clauses.push("customer_wp_user_id = :customerWpUserId");
    params.customerWpUserId = filter.customerWpUserId;
  }
  if (filter.customerEmail) {
    clauses.push("customer_email = :customerEmail");
    params.customerEmail = filter.customerEmail;
  }
  return query<DeliveryRow[]>(
    `SELECT * FROM iuw_deliveries WHERE ${clauses.join(" AND ")} ORDER BY assigned_at DESC`,
    params,
  );
}

export async function findDeliveryById(id: string): Promise<DeliveryRow | null> {
  const rows = await query<DeliveryRow[]>(
    `SELECT * FROM iuw_deliveries WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

export async function findActiveDeliveryForDriverCustomer(
  driverId: string,
  customer: { wpUserId?: number; email?: string },
): Promise<DeliveryRow | null> {
  const rows = await query<DeliveryRow[]>(
    `SELECT * FROM iuw_deliveries
     WHERE driver_id = :driverId
       AND deleted_at IS NULL
       AND status IN ('assigned', 'en-route', 'nearby', 'arrived')
       AND (
         (:wpUserId IS NOT NULL AND customer_wp_user_id = :wpUserId)
         OR (:email <> '' AND customer_email = :email)
       )
     ORDER BY assigned_at DESC LIMIT 1`,
    {
      driverId,
      wpUserId: customer.wpUserId ?? null,
      email: customer.email || "",
    },
  );
  return rows[0] || null;
}

export async function insertDelivery(row: {
  id: string;
  supplier_id: string;
  driver_id: string;
  wc_order_id: number;
  customer_wp_user_id: number | null;
  customer_email: string;
  status?: string;
}): Promise<DeliveryRow> {
  await withTransaction(async conn => {
    const [transactions] = await conn.query<(RowDataPacket & {status:string;supplier_id:string})[]>("SELECT status,supplier_id FROM iuw_transactions WHERE wc_order_id=? AND deleted_at IS NULL FOR UPDATE",[row.wc_order_id]);
    if (transactions[0]?.status !== "paid" || transactions[0]?.supplier_id !== row.supplier_id) throw validationError("Only a paid order for this supplier can be assigned.");
    const [existing] = await conn.query<RowDataPacket[]>("SELECT id FROM iuw_deliveries WHERE wc_order_id=? AND deleted_at IS NULL",[row.wc_order_id]);
    if (existing.length) throw conflict("This order already has a delivery. Use its reassignment action if another attempt is needed.");
    const [drivers] = await conn.query<(RowDataPacket & {active:number;status:string;supplier_id:string})[]>("SELECT active,status,supplier_id FROM iuw_drivers WHERE id=? AND deleted_at IS NULL FOR UPDATE",[row.driver_id]);
    if (!drivers[0]?.active || drivers[0].status!=="available" || drivers[0].supplier_id!==row.supplier_id) throw validationError("Choose an available driver belonging to your business.");
    await conn.query(`INSERT INTO iuw_deliveries (id,supplier_id,driver_id,wc_order_id,customer_wp_user_id,customer_email,status) VALUES (?,?,?,?,?,?,'assigned')`,[row.id,row.supplier_id,row.driver_id,row.wc_order_id,row.customer_wp_user_id,row.customer_email]);
    await conn.query("UPDATE iuw_drivers SET status='on-delivery' WHERE id=?",[row.driver_id]);
    await conn.query("INSERT INTO iuw_delivery_events (delivery_id,status,note) VALUES (?,'assigned','Supplier assigned driver.')",[row.id]);
    await enqueueDeliveryNotice(conn,"driver",row.driver_id,"New delivery assigned",`Order #${row.wc_order_id}: open Assigned runs to accept and start.`,row.id);
  });
  return (await findDeliveryById(row.id))!;
}

export async function updateDeliveryStatus(id: string, status: string): Promise<DeliveryRow | null> {
  const delivered = status === "delivered" ? new Date() : null;
  await execute(
    `UPDATE iuw_deliveries SET status = :status, delivered_at = COALESCE(:delivered, delivered_at)
     WHERE id = :id AND deleted_at IS NULL`,
    { id, status, delivered },
  );
  await execute(`INSERT INTO iuw_delivery_events (delivery_id, status, note) VALUES (:id, :status, '')`, {
    id,
    status,
  });
  return findDeliveryById(id);
}
