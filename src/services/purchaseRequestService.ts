import {
  isAdmin,
  isCustomer,
  isSupplier,
  requireRole,
  requireSignedIn,
  resolveSupplierScope,
  ROLES,
  type SessionLike,
} from "../authz/permissions.js";
import { accessDenied, notFound, validationError } from "../lib/errors.js";
import { config } from "../config.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { writeAudit } from "../repositories/auditRepo.js";
import { findProductOwner } from "../repositories/productRepo.js";
import { listSuppliers } from "../repositories/supplierRepo.js";
import { insertNotification } from "../repositories/notificationRepo.js";
import {
  acceptPurchaseRequest,
  findPurchaseRequestById,
  insertPurchaseOffers,
  insertPurchaseRequest,
  listPurchaseRequests,
  markCheckoutStarted,
  markPurchaseRequestPaid,
  type PurchaseRequestRow,
} from "../repositories/purchaseRequestRepo.js";
import { getWcProduct } from "../clients/woocommerce.js";

function mapRequest(row: PurchaseRequestRow) {
  return {
    id: row.id,
    customerWpUserId: Number(row.customer_wp_user_id),
    customerEmail: row.customer_email,
    wcProductId: Number(row.wc_product_id),
    productName: row.product_name,
    qty: Number(row.qty),
    status: row.status,
    acceptedSupplierId: row.accepted_supplier_id || null,
    wooOrderId: row.woo_order_id != null ? Number(row.woo_order_id) : null,
    wooOrderNumber: row.woo_order_number || null,
    checkoutUrl: row.checkout_url || "",
    createdAt: new Date(row.created_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : "",
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : "",
  };
}

function buildCheckoutUrl(wcProductId: number, qty: number, requestId: string): string {
  const base = config.WP_BASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({
    "add-to-cart": String(wcProductId),
    quantity: String(qty),
    iuw_request_id: requestId,
  });
  return `${base}/checkout/?${params.toString()}`;
}

async function suppliersForProduct(wcProductId: number): Promise<string[]> {
  const owner = await findProductOwner(wcProductId);
  if (owner?.supplier_id) return [owner.supplier_id];

  // Shared catalogue with no owner: notify all active companies.
  const active = await listSuppliers({ status: "active" });
  return active.map((row) => row.id);
}

export async function createPurchaseRequestFor(
  session: SessionLike,
  data: { wcProductId: number; qty?: number; productName?: string },
  ip?: string,
) {
  requireRole(session, ROLES.CUSTOMER);
  const principal = requireSignedIn(session);
  if (!principal.wpUserId) throw validationError("Sign in with a customer account.");

  const qty = Math.max(1, Math.floor(Number(data.qty) || 1));
  const wcProductId = Number(data.wcProductId);
  if (!Number.isFinite(wcProductId) || wcProductId <= 0) {
    throw validationError("Choose a product.");
  }

  let productName = String(data.productName || "").trim();
  try {
    const product = await getWcProduct(wcProductId);
    productName = productName || String(product?.name || `Product #${wcProductId}`);
  } catch {
    productName = productName || `Product #${wcProductId}`;
  }

  const supplierIds = await suppliersForProduct(wcProductId);
  if (!supplierIds.length) throw validationError("No companies are available for this product yet.");

  const id = makeId("prq");
  const row = await insertPurchaseRequest({
    id,
    customer_wp_user_id: principal.wpUserId,
    customer_email: normalizeEmail(principal.email),
    wc_product_id: wcProductId,
    product_name: productName,
    qty,
  });
  await insertPurchaseOffers(id, supplierIds);

  for (const supplierId of supplierIds) {
    await insertNotification({
      recipientKind: "supplier",
      recipientId: supplierId,
      title: "New product request",
      body: `A customer wants ${qty} × ${productName}. Accept to open checkout.`,
      kind: "purchase_request",
      refType: "purchase_request",
      refId: id,
    });
  }

  await writeAudit({
    session,
    action: "purchase_request.create",
    targetType: "purchase_request",
    targetId: id,
    ip,
    after: mapRequest(row),
  });

  return mapRequest(row);
}

export async function listPurchaseRequestsFor(session: SessionLike) {
  const principal = requireSignedIn(session);
  if (isAdmin(principal)) {
    return (await listPurchaseRequests({})).map(mapRequest);
  }
  if (isSupplier(principal)) {
    const scope = resolveSupplierScope(principal);
    return (await listPurchaseRequests({ supplierId: scope! })).map(mapRequest);
  }
  if (isCustomer(principal) && principal.wpUserId) {
    return (await listPurchaseRequests({ customerWpUserId: principal.wpUserId })).map(mapRequest);
  }
  throw accessDenied();
}

export async function getPurchaseRequestFor(session: SessionLike, id: string) {
  const principal = requireSignedIn(session);
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");

  if (isAdmin(principal)) return mapRequest(row);
  if (isCustomer(principal) && Number(row.customer_wp_user_id) === Number(principal.wpUserId)) {
    return mapRequest(row);
  }
  if (isSupplier(principal)) {
    const scope = resolveSupplierScope(principal);
    const mine = await listPurchaseRequests({ supplierId: scope! });
    if (mine.some((item) => item.id === id)) return mapRequest(row);
  }
  throw accessDenied();
}

export async function acceptPurchaseRequestFor(session: SessionLike, id: string, ip?: string) {
  requireRole(session, ROLES.SUPPLIER);
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  if (row.status !== "open") throw validationError("This request is no longer open.");

  const scope = resolveSupplierScope(session)!;
  const checkoutUrl = buildCheckoutUrl(Number(row.wc_product_id), Number(row.qty), row.id);
  const accepted = await acceptPurchaseRequest(id, scope, checkoutUrl);

  await insertNotification({
    recipientKind: "wp",
    recipientId: String(row.customer_wp_user_id),
    title: "Company accepted your request",
    body: `Pay on the website to complete ${row.product_name}.`,
    kind: "purchase_accepted",
    refType: "purchase_request",
    refId: id,
  });

  await writeAudit({
    session,
    action: "purchase_request.accept",
    targetType: "purchase_request",
    targetId: id,
    ip,
    after: mapRequest(accepted),
  });

  return mapRequest(accepted);
}

export async function startCheckoutFor(session: SessionLike, id: string) {
  const principal = requireRole(session, ROLES.CUSTOMER);
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  if (Number(row.customer_wp_user_id) !== Number(principal.wpUserId)) throw accessDenied();
  if (row.status !== "accepted" && row.status !== "checkout_started") {
    throw validationError("Wait for a company to accept before paying.");
  }
  await markCheckoutStarted(id);
  return { ...mapRequest({ ...row, status: "checkout_started" }), checkoutUrl: row.checkout_url };
}

/**
 * Called from Woo order webhook when status maps to paid.
 * Requires matching iuw_request_id meta + customer WP user id.
 */
export async function fulfillPurchaseRequestFromOrder(input: {
  requestId: string;
  customerWpUserId: number | null;
  customerEmail: string;
  wooOrderId: number;
  wooOrderNumber: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const row = await findPurchaseRequestById(input.requestId);
  if (!row) return { ok: false, reason: "request_not_found" };

  const emailMatch =
    normalizeEmail(row.customer_email) &&
    normalizeEmail(row.customer_email) === normalizeEmail(input.customerEmail);
  const userMatch =
    input.customerWpUserId != null && Number(row.customer_wp_user_id) === Number(input.customerWpUserId);

  if (!userMatch && !emailMatch) {
    return { ok: false, reason: "customer_mismatch" };
  }

  const customerWpUserId = userMatch ? Number(input.customerWpUserId) : Number(row.customer_wp_user_id);
  const paid = await markPurchaseRequestPaid({
    requestId: input.requestId,
    customerWpUserId,
    wooOrderId: input.wooOrderId,
    wooOrderNumber: input.wooOrderNumber,
  });

  if (paid) {
    await insertNotification({
      recipientKind: "wp",
      recipientId: String(row.customer_wp_user_id),
      title: "Payment confirmed",
      body: `Order ${input.wooOrderNumber} is paid for ${row.product_name}.`,
      kind: "purchase_paid",
      refType: "purchase_request",
      refId: row.id,
    });
    if (row.accepted_supplier_id) {
      await insertNotification({
        recipientKind: "supplier",
        recipientId: row.accepted_supplier_id,
        title: "Customer paid",
        body: `Order ${input.wooOrderNumber} paid for ${row.product_name}.`,
        kind: "purchase_paid",
        refType: "purchase_request",
        refId: row.id,
      });
    }
  }

  return { ok: paid, reason: paid ? undefined : "not_updated" };
}
