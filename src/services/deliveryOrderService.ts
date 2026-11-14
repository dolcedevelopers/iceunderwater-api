import type { RowDataPacket } from "mysql2";
import { requireRole, ROLES, isAdmin, type SessionLike } from "../authz/permissions.js";
import { query } from "../db/pool.js";
export async function availableDeliveryOrders(session:SessionLike) {
  const person=requireRole(session,ROLES.ADMIN,ROLES.SUPPLIER);
  const rows=await query<(RowDataPacket & {wc_order_id:number;reference:string;customer_email:string;supplier_id:string;total_cents:number})[]>(`SELECT t.wc_order_id,t.reference,t.customer_email,t.supplier_id,t.total_cents FROM iuw_transactions t
    WHERE t.status='paid' AND t.deleted_at IS NULL ${isAdmin(person)?"":"AND t.supplier_id=:supplier"}
    AND NOT EXISTS (SELECT 1 FROM iuw_deliveries d WHERE d.wc_order_id=t.wc_order_id AND d.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM iuw_purchase_requests r WHERE r.woo_order_id=t.wc_order_id AND r.fulfilment_type='pickup') ORDER BY t.created_at DESC LIMIT 200`,isAdmin(person)?{}:{supplier:person.supplierId||""});
  return rows.map(row=>({orderId:Number(row.wc_order_id),reference:row.reference,customerEmail:row.customer_email,supplierId:row.supplier_id,total:Number(row.total_cents)/100}));
}
