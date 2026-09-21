import {
  canCreatePurchaseRequests,
  isAdmin,
  isCustomer,
  isSupplier,
  PURCHASE_REQUEST_ACCEPT_WINDOW_MINUTES,
  requireRole,
  requireSignedIn,
  resolveSupplierScope,
  ROLES,
  type Principal,
  type SessionLike,
} from "../authz/permissions.js";
import { accessDenied, notFound, validationError } from "../lib/errors.js";
import { config } from "../config.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { writeAudit } from "../repositories/auditRepo.js";
import { findProductOwner, listSupplierIdsForProductCategory } from "../repositories/productRepo.js";
import { insertNotification } from "../repositories/notificationRepo.js";
import {
  acceptPurchaseRequest,
  expireStalePurchaseRequests,
  findPurchaseRequestById,
  insertPurchaseOffers,
  insertPurchaseRequest,
  listPurchaseRequests,
  markCheckoutStarted,
  markPurchaseRequestPaid,
  resendPurchaseRequest,
  type PurchaseRequestRow,
} from "../repositories/purchaseRequestRepo.js";
import { getWcProduct } from "../clients/woocommerce.js";

/**
 * `checkoutUrl` is the buyer's payment link. The accepting company waits to be
 * paid, so it is stripped for every audience except the account that raised
 * the request — including when that account is itself a company.
 */
function mapRequest(row: PurchaseRequestRow, options: { includeCheckoutUrl?: boolean } = {}) {
  return {
    id: row.id,
    customerWpUserId: Number(row.customer_wp_user_id),
    customerEmail: row.customer_email,
    requesterSupplierId: row.requester_supplier_id || null,
    requesterKind: row.requester_supplier_id ? ("company" as const) : ("customer" as const),
    wcProductId: Number(row.wc_product_id),
    productName: row.product_name,
    qty: Number(row.qty),
    status: row.status,
    acceptedSupplierId: row.accepted_supplier_id || null,
    wooOrderId: row.woo_order_id != null ? Number(row.woo_order_id) : null,
    wooOrderNumber: row.woo_order_number || null,
    checkoutUrl: options.includeCheckoutUrl ? row.checkout_url || "" : "",
    /** Deadline for a company to accept. Drives the countdown in the app. */
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : "",
    acceptWindowMinutes: PURCHASE_REQUEST_ACCEPT_WINDOW_MINUTES,
    resendCount: Number(row.resend_count) || 0,
    createdAt: new Date(row.created_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : "",
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : "",
  };
}

/** The account that raised the request: a shopper, or a company buying stock. */
function requesterOf(session: SessionLike): { principal: Principal; supplierId: string | null } {
  const principal = requireSignedIn(session);
  if (!canCreatePurchaseRequests(principal)) {
    throw accessDenied("Your account cannot place orders.");
  }
  if (!principal.wpUserId) throw validationError("Sign in again to place an order.");
  return {
    principal,
    supplierId: isSupplier(principal) ? resolveSupplierScope(principal) : null,
  };
}

function ownsRequest(row: PurchaseRequestRow, requester: { principal: Principal; supplierId: string | null }) {
  if (requester.supplierId) return row.requester_supplier_id === requester.supplierId;
  return Number(row.customer_wp_user_id) === Number(requester.principal.wpUserId);
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

/**
 * Who should see this request: the company that owns the product, plus any
 * company stocking the same category. Never every company on the platform —
 * a clothing seller should not be pinged about ice.
 */
async function suppliersForProduct(wcProductId: number): Promise<string[]> {
  const ids = new Set<string>();

  const owner = await findProductOwner(wcProductId);
  if (owner?.supplier_id) ids.add(owner.supplier_id);

  for (const supplierId of await listSupplierIdsForProductCategory(wcProductId)) {
    ids.add(supplierId);
  }

  return [...ids];
}

function includeCheckoutUrl(session: SessionLike, row: PurchaseRequestRow): boolean {
  if (isAdmin(session)) return false;
  if (isSupplier(session)) {
    return Boolean(session?.supplierId) && row.requester_supplier_id === session?.supplierId;
  }
  if (isCustomer(session)) {
    return Number(row.customer_wp_user_id) === Number(session?.wpUserId);
  }
  return false;
}

function buyerLabel(requesterSupplierId: string | null): string {
  return requesterSupplierId ? "A company" : "A customer";
}

async function targetsForProduct(wcProductId: number, excludeSupplierId: string | null): Promise<string[]> {
  return (await suppliersForProduct(wcProductId)).filter((id) => id !== excludeSupplierId);
}

async function notifySuppliers(input: {
  requestId: string;
  supplierIds: string[];
  qty: number;
  productName: string;
  requesterSupplierId: string | null;
}): Promise<void> {
  for (const supplierId of input.supplierIds) {
    await insertNotification({
      recipientKind: "supplier",
      recipientId: supplierId,
      title: "New product request",
      body: `${buyerLabel(input.requesterSupplierId)} wants ${input.qty} × ${input.productName}. Accept to open checkout.`,
      kind: "purchase_request",
      refType: "purchase_request",
      refId: input.requestId,
    });
  }
}

export async function createPurchaseRequestFor(
  session: SessionLike,
  data: { wcProductId: number; qty?: number; productName?: string },
  ip?: string,
) {
  const requester = requesterOf(session);

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

  const supplierIds = await targetsForProduct(wcProductId, requester.supplierId);
  if (!supplierIds.length) {
    throw validationError(
      requester.supplierId
        ? "No other companies currently sell this product."
        : "No companies are available for this product yet.",
    );
  }

  const id = makeId("prq");
  const row = await insertPurchaseRequest({
    id,
    customer_wp_user_id: requester.principal.wpUserId,
    customer_email: normalizeEmail(requester.principal.email),
    requester_supplier_id: requester.supplierId,
    wc_product_id: wcProductId,
    product_name: productName,
    qty,
    window_minutes: PURCHASE_REQUEST_ACCEPT_WINDOW_MINUTES,
  });
  await insertPurchaseOffers(id, supplierIds);
  await notifySuppliers({
    requestId: id,
    supplierIds,
    qty,
    productName,
    requesterSupplierId: requester.supplierId,
  });

  await writeAudit({
    session,
    action: "purchase_request.create",
    targetType: "purchase_request",
    targetId: id,
    ip,
    after: mapRequest(row),
  });

  return mapRequest(row, { includeCheckoutUrl: true });
}

export async function listPurchaseRequestsFor(session: SessionLike) {
  const principal = requireSignedIn(session);
  await expireStalePurchaseRequests();
  if (isAdmin(principal)) {
    return (await listPurchaseRequests({})).map((row) => mapRequest(row));
  }
  if (isSupplier(principal)) {
    const scope = resolveSupplierScope(principal);
    return (await listPurchaseRequests({ supplierId: scope! })).map((row) =>
      mapRequest(row, { includeCheckoutUrl: includeCheckoutUrl(principal, row) }),
    );
  }
  if (isCustomer(principal) && principal.wpUserId) {
    return (await listPurchaseRequests({ customerWpUserId: principal.wpUserId })).map((row) =>
      mapRequest(row, { includeCheckoutUrl: true }),
    );
  }
  throw accessDenied();
}

export async function getPurchaseRequestFor(session: SessionLike, id: string) {
  const principal = requireSignedIn(session);
  await expireStalePurchaseRequests();
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");

  if (isAdmin(principal)) return mapRequest(row);
  if (includeCheckoutUrl(principal, row) || (isCustomer(principal) && Number(row.customer_wp_user_id) === Number(principal.wpUserId))) {
    return mapRequest(row, { includeCheckoutUrl: includeCheckoutUrl(principal, row) });
  }
  if (isSupplier(principal)) {
    const scope = resolveSupplierScope(principal);
    const mine = await listPurchaseRequests({ supplierId: scope! });
    if (mine.some((item) => item.id === id)) return mapRequest(row, { includeCheckoutUrl: includeCheckoutUrl(principal, row) });
  }
  throw accessDenied();
}

export async function acceptPurchaseRequestFor(session: SessionLike, id: string, ip?: string) {
  requireRole(session, ROLES.SUPPLIER);
  await expireStalePurchaseRequests();
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  if (row.status !== "open") throw validationError("This request is no longer open.");

  const scope = resolveSupplierScope(session)!;
  if (row.requester_supplier_id && row.requester_supplier_id === scope) {
    throw accessDenied("You cannot accept your own order.");
  }
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
  const requester = requesterOf(session);
  await expireStalePurchaseRequests();
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  if (!ownsRequest(row, requester)) throw accessDenied();
  if (row.status !== "accepted" && row.status !== "checkout_started") {
    throw validationError("Wait for a company to accept before paying.");
  }
  await markCheckoutStarted(id);
  return mapRequest({ ...row, status: "checkout_started" }, { includeCheckoutUrl: true });
}

export async function resendPurchaseRequestFor(
  session: SessionLike,
  id: string,
  data: { qty?: number } = {},
  ip?: string,
) {
  const requester = requesterOf(session);
  await expireStalePurchaseRequests();
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  if (!ownsRequest(row, requester)) throw accessDenied();
  if (row.status !== "open" && row.status !== "expired") {
    throw validationError("This request can no longer be changed.");
  }

  const qty = Math.max(1, Math.floor(Number(data.qty) || Number(row.qty) || 1));
  const supplierIds = await targetsForProduct(Number(row.wc_product_id), requester.supplierId);
  if (!supplierIds.length) {
    throw validationError(
      requester.supplierId
        ? "No other companies currently sell this product."
        : "No companies are available for this product yet.",
    );
  }

  const updated = await resendPurchaseRequest({
    requestId: id,
    qty,
    windowMinutes: PURCHASE_REQUEST_ACCEPT_WINDOW_MINUTES,
  });
  await insertPurchaseOffers(id, supplierIds);
  await notifySuppliers({
    requestId: id,
    supplierIds,
    qty,
    productName: row.product_name,
    requesterSupplierId: requester.supplierId,
  });

  await writeAudit({
    session,
    action: "purchase_request.resend",
    targetType: "purchase_request",
    targetId: id,
    ip,
    before: mapRequest(row),
    after: mapRequest(updated),
  });

  return mapRequest(updated, { includeCheckoutUrl: true });
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
