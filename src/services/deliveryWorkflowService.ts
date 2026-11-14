import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "../db/pool.js";
import { isAdmin, isDriver, isSupplier, requireSignedIn, type SessionLike } from "../authz/permissions.js";
import { accessDenied, conflict, notFound, validationError } from "../lib/errors.js";
import { makeId } from "../lib/ids.js";
import { checkDeliveryAccess, deliveryTransition, ownsDelivery, type DeliveryAction, type DeliveryState } from "../lib/deliveryFlow.js";

export type WorkflowRow = RowDataPacket & DeliveryState & { id: string; wc_order_id: number; assigned_at: Date; accepted_at: Date | null; arrived_at: Date | null; collect_by: Date | null; delivered_at: Date | null; recipient_name: string | null; receipt_wp_user_id: number | null; failure_reason: string | null; redelivery_reason: string | null; requested_at: Date | null; attempt_number: number };
export async function enqueueDeliveryNotice(conn: PoolConnection, kind: "wp" | "driver" | "supplier", recipient: string | number | null, title: string, body: string, deliveryId: string, type = "delivery") {
  if (!recipient) return;
  const id = makeId("ntf");
  await conn.query(`INSERT INTO iuw_notifications (id,recipient_kind,recipient_id,title,body,kind,ref_type,ref_id) VALUES (?,?,?,?,?,?,'delivery',?)`,[id,kind,String(recipient),title,body,type,deliveryId]);
}
async function event(conn: PoolConnection, row: WorkflowRow, status: string, note: string, details: unknown) {
  await conn.query("INSERT INTO iuw_delivery_events (delivery_id,status,note,details) VALUES (?,?,?,?)",[row.id,status,note.slice(0,512),JSON.stringify(details)]);
}
export async function expireDelivery(conn: PoolConnection, row: WorkflowRow, now: Date) {
  if (row.status !== "arrived" || !row.collect_by || new Date(row.collect_by).getTime() > now.getTime()) return;
  const reason = "Not collected within the 20-minute arrival window.";
  await conn.query("UPDATE iuw_deliveries SET status='not_delivered',failure_reason=? WHERE id=?",[reason,row.id]);
  await conn.query("UPDATE iuw_drivers SET status='available' WHERE id=?",[row.driver_id]);
  await event(conn,row,"not_delivered",reason,{ actor: "system", attempt: row.attempt_number, collectBy: row.collect_by });
  await enqueueDeliveryNotice(conn,"wp",row.customer_wp_user_id,"Delivery not collected",`Order #${row.wc_order_id}: the 20-minute window ended. Open deliveries to request redelivery.`,row.id);
  await enqueueDeliveryNotice(conn,"supplier",row.supplier_id,"Delivery not collected",`Order #${row.wc_order_id} was not collected.`,row.id);
  await enqueueDeliveryNotice(conn,"driver",row.driver_id,"Collection window ended",`Order #${row.wc_order_id} is recorded as not delivered.`,row.id);
  row.status="not_delivered"; row.failure_reason=reason;
}
export async function sweepMissedDeliveries() {
  const rows=await query<(RowDataPacket & { id:string })[]>("SELECT id FROM iuw_deliveries WHERE status='arrived' AND collect_by<=UTC_TIMESTAMP(3) AND deleted_at IS NULL LIMIT 100");
  for (const row of rows) await withTransaction(async conn=>{const [found]=await conn.query<WorkflowRow[]>("SELECT * FROM iuw_deliveries WHERE id=? FOR UPDATE",[row.id]);if(found[0])await expireDelivery(conn,found[0],new Date());});
}
function iso(value: unknown) { return value ? new Date(value as string | Date).toISOString() : null; }
export async function deliveriesFor(session: SessionLike) {
  const person=requireSignedIn(session); const params: unknown[]=[]; let filter="1=1";
  if (!isAdmin(person)) {
    if (isDriver(person)) { filter="d.driver_id=?";params.push(person.driverId); }
    else if (isSupplier(person)) { filter="(d.supplier_id=? OR d.customer_wp_user_id=?)";params.push(person.supplierId || "",person.wpUserId); }
    else {filter="d.customer_wp_user_id=?";params.push(person.wpUserId);}
  }
  const rows=await query<(WorkflowRow & {driver_name:string;driver_phone:string;supplier_name:string;supplier_phone:string;supplier_email:string;address:string;slot:Date|null;product_name:string;qty:number})[]>(`SELECT d.*, v.name AS driver_name,v.phone AS driver_phone,s.name AS supplier_name,s.phone AS supplier_phone,s.email AS supplier_email,
    (SELECT CONCAT_WS(', ',r.location_address,r.location_city,r.location_province) FROM iuw_purchase_requests r WHERE r.woo_order_id=d.wc_order_id ORDER BY r.created_at DESC LIMIT 1) AS address,
    (SELECT r.delivery_at FROM iuw_purchase_requests r WHERE r.woo_order_id=d.wc_order_id ORDER BY r.created_at DESC LIMIT 1) AS slot,
    (SELECT GROUP_CONCAT(CONCAT(l.quantity,' x ',l.name) SEPARATOR '; ') FROM iuw_transaction_lines l JOIN iuw_transactions t ON t.id=l.transaction_id WHERE t.wc_order_id=d.wc_order_id) AS product_name
    FROM iuw_deliveries d JOIN iuw_drivers v ON v.id=d.driver_id JOIN iuw_suppliers s ON s.id=d.supplier_id WHERE d.deleted_at IS NULL AND ${filter} ORDER BY d.assigned_at DESC LIMIT 250`,params);
  return rows.map(row=>({ id:row.id,driverId:row.driver_id,supplierId:row.supplier_id,orderId:Number(row.wc_order_id),customerEmail:row.customer_email,status:row.status,
    driverName:row.driver_name,driverPhone:row.driver_phone,supplierName:row.supplier_name,supplierPhone:row.supplier_phone,supplierEmail:row.supplier_email,address:row.address || "Contact the supplier to confirm the delivery address.",items:row.product_name || "See order details",
    assignedAt:iso(row.assigned_at),acceptedAt:iso(row.accepted_at),arrivedAt:iso(row.arrived_at),collectBy:iso(row.collect_by),deliveredAt:iso(row.delivered_at),deliveryAt:iso(row.requested_at || row.slot),recipientName:row.recipient_name,
    failureReason:row.failure_reason,redeliveryReason:row.redelivery_reason,attempt:Number(row.attempt_number),canReceive:ownsDelivery(person,row),canManage:isAdmin(person)||(isSupplier(person)&&person.supplierId===row.supplier_id),canDrive:isDriver(person)&&person.driverId===row.driver_id,serverTime:new Date().toISOString() }));
}
export async function deliveryHistory(session: SessionLike,id:string) {
  const rows=await query<WorkflowRow[]>("SELECT * FROM iuw_deliveries WHERE id=? AND deleted_at IS NULL",[id]);if(!rows[0])throw notFound("That delivery is not available.");checkDeliveryAccess(session,rows[0]);
  const events=await query<(RowDataPacket & {status:string;note:string;details:string|null;created_at:Date})[]>("SELECT status,note,details,created_at FROM iuw_delivery_events WHERE delivery_id=? ORDER BY id DESC",[id]);
  return events.map(e=>({status:e.status,note:e.note,createdAt:iso(e.created_at)}));
}
export async function deliveryAction(session: SessionLike,id:string,action:DeliveryAction,data:{reason?:string;recipientName?:string;confirmed?:boolean;deliveryAt?:string;driverId?:string}={}) {
  requireSignedIn(session);
  await withTransaction(async conn=>{
    const [rows]=await conn.query<WorkflowRow[]>("SELECT * FROM iuw_deliveries WHERE id=? AND deleted_at IS NULL FOR UPDATE",[id]);const row=rows[0];if(!row)throw notFound("That delivery is not available.");
    checkDeliveryAccess(session,row);const now=new Date();
    // Return an expired receive attempt without throwing inside the transaction: expiry must commit.
    await expireDelivery(conn,row,now);
    if(["receive","not-collected"].includes(action) && row.status==="not_delivered") return;
    const target=deliveryTransition(session,row,action,now);
    if(action==="receive" && (!data.confirmed || !data.recipientName?.trim() || data.recipientName.trim().length>160))throw validationError("Confirm you received the goods and enter the recipient name.");
    if(["redeliver","decline"].includes(action) && (!data.reason || data.reason.trim().length<5 || data.reason.length>512))throw validationError("Enter a reason of 5 to 512 characters.");
    let requested:Date|null=null;
    if(action==="redeliver") {requested=new Date(data.deliveryAt || "");if(!Number.isFinite(requested.getTime())||requested.getTime()<=now.getTime())throw validationError("Choose a future date and time for redelivery.");}
    let nextDriver=row.driver_id;
    if(action==="reassign") {
      const [drivers]=await conn.query<(RowDataPacket & {id:string;supplier_id:string;active:number;status:string})[]>("SELECT * FROM iuw_drivers WHERE id=? AND deleted_at IS NULL FOR UPDATE",[data.driverId||""]);
      const driver=drivers[0];if(!driver||driver.supplier_id!==row.supplier_id||!driver.active||driver.status!=="available")throw validationError("Choose an available driver belonging to this supplier.");
      const [transactions]=await conn.query<(RowDataPacket & {status:string})[]>("SELECT status FROM iuw_transactions WHERE wc_order_id=? AND deleted_at IS NULL FOR UPDATE",[row.wc_order_id]);
      if(transactions[0]?.status!=="paid")throw validationError("The order must still be paid before reassignment.");nextDriver=driver.id;
    }
    const arrived=action==="arrive"?now:row.arrived_at;const collectBy=action==="arrive"?new Date(now.getTime()+20*60000):row.collect_by;
    await conn.query(`UPDATE iuw_deliveries SET status=?,driver_id=?,accepted_at=?,arrived_at=?,collect_by=?,delivered_at=?,recipient_name=?,receipt_wp_user_id=?,failure_reason=?,redelivery_reason=?,requested_at=?,attempt_number=attempt_number+?,assigned_at=IF(?,UTC_TIMESTAMP(3),assigned_at) WHERE id=?`,
      [target,nextDriver,action==="start"?now:action==="reassign"?null:row.accepted_at,action==="reassign"?null:arrived,action==="reassign"?null:collectBy,action==="receive"?now:null,action==="receive"?data.recipientName!.trim():null,action==="receive"?session!.wpUserId:null,action==="decline"?data.reason!.trim():row.failure_reason,action==="redeliver"?data.reason!.trim():row.redelivery_reason,requested||row.requested_at,action==="reassign"?1:0,action==="reassign",id]);
    if(["decline","not-collected","receive"].includes(action))await conn.query("UPDATE iuw_drivers SET status='available' WHERE id=?",[row.driver_id]);
    if(action==="reassign")await conn.query("UPDATE iuw_drivers SET status='on-delivery' WHERE id=?",[nextDriver]);
    await event(conn,row,target,data.reason?.trim()||({start:"Driver accepted and started delivery.",arrive:"Driver arrived. Collection window: 20 minutes.",receive:`Received by ${data.recipientName?.trim()}.`,reassign:"Supplier assigned the next delivery attempt.",decline:"Driver declined.",redeliver:"Customer requested redelivery.","not-collected":"Not collected."}[action] || "Delivery updated."),{action,actor:session!.role,wpUserId:session!.wpUserId,driverId:nextDriver,previousDriverId:row.driver_id,attempt:row.attempt_number,recipientName:data.recipientName,confirmed:data.confirmed,requestedAt:requested});
    if(action==="start")await enqueueDeliveryNotice(conn,"wp",row.customer_wp_user_id,"Your delivery is on its way",`Order #${row.wc_order_id}: your driver accepted the run. Open the map to follow progress.`,id);
    if(action==="arrive")await enqueueDeliveryNotice(conn,"wp",row.customer_wp_user_id,"Your delivery is outside",`Order #${row.wc_order_id}: please collect within 20 minutes and confirm receipt.`,id,"arrival");
    if(action==="decline"||action==="redeliver"||action==="receive")await enqueueDeliveryNotice(conn,"supplier",row.supplier_id,action==="decline"?"Driver declined delivery":action==="redeliver"?"Redelivery requested":"Customer confirmed receipt",`Order #${row.wc_order_id}: ${data.reason||data.recipientName||target}`,id);
    if(action==="receive")await conn.query("UPDATE iuw_notifications SET read_at=COALESCE(read_at,UTC_TIMESTAMP(3)) WHERE recipient_kind='wp' AND recipient_id=? AND ref_type='delivery' AND ref_id=?",[String(row.customer_wp_user_id),id]);
    if(action==="receive")await enqueueDeliveryNotice(conn,"driver",row.driver_id,"Delivery complete",`Order #${row.wc_order_id}: the customer confirmed receipt.`,id);
    if(action==="reassign")await enqueueDeliveryNotice(conn,"driver",nextDriver,"New delivery assigned",`Order #${row.wc_order_id}: open Assigned runs to accept and start.`,id);
  });
  const rows=await deliveriesFor(session);return rows.find(row=>row.id===id);
}
