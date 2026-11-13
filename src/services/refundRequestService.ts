import { canCreatePurchaseRequests, isSupplier, requireSignedIn, resolveSupplierScope, type SessionLike } from "../authz/permissions.js";
import { accessDenied, AppError, conflict, notFound, validationError } from "../lib/errors.js";
import { findPurchaseRequestById, type PurchaseRequestRow } from "../repositories/purchaseRequestRepo.js";
import { findSupplierById } from "../repositories/supplierRepo.js";
import { sendRefundRequestEmail } from "../clients/wordpress.js";

async function context(session: SessionLike, id: string) {
  const principal = requireSignedIn(session);
  if (!canCreatePurchaseRequests(principal)) throw accessDenied();
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  const supplierId = isSupplier(principal) ? resolveSupplierScope(principal) : null;
  if (supplierId ? row.requester_supplier_id !== supplierId : row.requester_supplier_id != null || Number(row.customer_wp_user_id) !== principal.wpUserId) throw accessDenied();
  if (row.status !== "paid" || !row.woo_order_id || !row.accepted_supplier_id) throw validationError("Refund requests are available for paid orders only.");
  const supplier = await findSupplierById(row.accepted_supplier_id);
  if (!supplier || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(supplier.email)) throw validationError("The supplier has no valid refund contact email. Please contact support.");
  return { principal, row, supplier, supplierId };
}
export function refundMessage(row: PurchaseRequestRow, supplierName: string, reason = "") {
  const number = row.woo_order_number || String(row.woo_order_id);
  const subject = `Refund request - Order ${number} - ${row.product_name}`.replace(/[\r\n]/g, " ").slice(0, 200);
  const prefix = `Hello ${supplierName},\n\nI would like to request a refund for:\n\nOrder: ${number} (Woo ID ${row.woo_order_id})\nProduct: ${row.product_name} (Product ID ${row.wc_product_id})\nQuantity: ${row.qty}\nPurchase request: ${row.id}\nCustomer email: ${row.customer_email}\n\nReason: `;
  const suffix = "\n\nPlease advise on the next steps for reviewing this refund request and any return requirements.\n\nThank you.";
  return { subject, prefix, suffix, body: prefix + (reason || "[Enter your reason below]") + suffix };
}
export async function refundPreviewFor(session: SessionLike, id: string) {
  const { row, supplier } = await context(session, id);
  return { to: supplier.email, supplier: { id: supplier.id, name: supplier.name, email: supplier.email, phone: supplier.phone, address: supplier.address },
    ...refundMessage(row, supplier.name, row.refund_reason || ""), status: row.refund_status || null,
    sentAt: row.refund_requested_at ? new Date(row.refund_requested_at).toISOString() : null };
}
export async function sendRefundRequestFor(session: SessionLike, id: string, reason: string) {
  const { principal, row, supplier, supplierId } = await context(session, id);
  const clean = String(reason || "").trim();
  if (clean.length < 5 || clean.length > 2000) throw validationError("Describe the reason for your refund request (5 to 2,000 characters).");
  if (row.refund_status === "sent") return { status: "sent", to: supplier.email, sentAt: row.refund_requested_at ? new Date(row.refund_requested_at).toISOString() : null, alreadySent: true };
  if (row.refund_status === "sending") throw conflict("Your refund request is being sent. Check its status before trying again.");
  try {
    return await sendRefundRequestEmail({ requestId: id, customerWpUserId: principal.wpUserId!, requesterSupplierId: supplierId, reason: clean });
  } catch (error) {
    if (error instanceof AppError && error.status === 404) throw new AppError(503, "UPSTREAM_ERROR", "Refund email is not available yet. You can open your email app to contact the supplier.", { expose: true });
    throw error;
  }
}
