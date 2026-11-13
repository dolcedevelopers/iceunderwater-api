import { listStockingSupplierIds } from "../repositories/productRepo.js";
import { requestLocation, supplierServesLocation, type RequestLocation } from "../lib/serviceArea.js";
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
import { listSuppliers } from "../repositories/supplierRepo.js";
import { insertNotification } from "../repositories/notificationRepo.js";
import {
  cancelPurchaseRequest,
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
export function validateDeliveryAt(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw validationError("Choose a delivery date and time.");
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate()) throw validationError("Choose a valid delivery date.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw validationError("Choose a delivery date and time in the future.");
  return date;
}

function mapRequest(row: PurchaseRequestRow, options: { includeCheckoutUrl?: boolean } = {}) {
  return {
    id: row.id,
    customerWpUserId: Number(row.customer_wp_user_id),
    customerEmail: row.customer_email,
    requesterSupplierId: row.requester_supplier_id || null,
    targetSupplierId: row.target_supplier_id || null,
    requesterKind: row.requester_supplier_id ? ("company" as const) : ("customer" as const),
    wcProductId: Number(row.wc_product_id),
    productName: row.product_name,
    qty: Number(row.qty),
    status: row.status,
    deliveryStatus: row.delivery_status || null,
    location: row.location_address ? {
      address: row.location_address, province: row.location_province || "", city: row.location_city || "",
      fulfilmentType: row.fulfilment_type || "delivery",
    } : null,
    deliveryAt: row.delivery_at ? new Date(row.delivery_at).toISOString() : null,
    deliveryTimezone: "Africa/Johannesburg",
    acceptedSupplierId: row.accepted_supplier_id || null,
    supplierContact: options.includeCheckoutUrl && row.accepted_supplier_id ? {
      id: row.accepted_supplier_id, name: row.supplier_contact_name || "Supplier",
      email: row.supplier_contact_email || "", phone: row.supplier_contact_phone || "", address: row.supplier_contact_address || "",
    } : null,
    refundRequest: options.includeCheckoutUrl && row.refund_status ? {
      status: row.refund_status, reason: row.refund_reason || "", sentAt: row.refund_requested_at ? new Date(row.refund_requested_at).toISOString() : null,
    } : null,
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

export async function listPurchaseSuppliersFor(session: SessionLike) {
  const requester = requesterOf(session);
  const [suppliers, history] = await Promise.all([
    listSuppliers({ status: "active" }),
    listPurchaseRequests(requester.supplierId
      ? { supplierId: requester.supplierId }
      : { customerWpUserId: requester.principal.wpUserId }),
  ]);
  const previous = new Set(history.filter((row) => ownsRequest(row, requester) && row.status === "paid")
    .map((row) => row.accepted_supplier_id));
  return suppliers.filter((row) => row.id !== requester.supplierId).map((row) => ({
    id: row.id, name: row.name, city: row.city, previous: previous.has(row.id),
  }));
}

async function eligibleSuppliers(session: SessionLike, wcProductId: number, qty: number, location: RequestLocation) {
  const requester = requesterOf(session);
  const [suppliers, stockingIds] = await Promise.all([
    listSuppliers({ status: "active" }), listStockingSupplierIds(wcProductId, qty),
  ]);
  const stocking = new Set(stockingIds);
  return suppliers.filter((supplier) => supplier.id !== requester.supplierId
    && stocking.has(supplier.id) && supplierServesLocation(supplier, location));
}

export async function matchPurchaseSuppliersFor(session: SessionLike, data: {
  items: { wcProductId: number; qty: number }[]; location: RequestLocation;
}) {
  requesterOf(session);
  const location = requestLocation(data.location);
  const matches = await Promise.all(data.items.map((item) => eligibleSuppliers(session, item.wcProductId, item.qty, location)));
  const common = matches[0]?.filter((supplier) => matches.every((group) => group.some((entry) => entry.id === supplier.id))) || [];
  const history = await listPurchaseSuppliersFor(session);
  return {
    allAvailable: matches.length > 0 && matches.every((group) => group.length > 0),
    suppliers: common.map((supplier) => ({ id: supplier.id, name: supplier.name, city: supplier.city,
      previous: Boolean(history.find((entry) => entry.id === supplier.id)?.previous),
      province: supplier.province })),
  };
}

async function targetsForSelection(session: SessionLike, wcProductId: number, qty: number, location: RequestLocation, targetSupplierId?: string | null): Promise<string[]> {
  const suppliers = await eligibleSuppliers(session, wcProductId, qty, location);
  if (targetSupplierId) {
    if (!suppliers.some((row) => row.id === targetSupplierId)) {
      throw validationError("This supplier does not have enough stock of the product or is not in the selected city.");
    }
    return [targetSupplierId];
  }
  return suppliers.map((row) => row.id);
}

async function notifySuppliers(input: {
  requestId: string;
  supplierIds: string[];
  qty: number;
  productName: string;
  requesterSupplierId: string | null;
  deliveryAt: Date;
  location: RequestLocation;
}): Promise<void> {
  for (const supplierId of input.supplierIds) {
    await insertNotification({
      recipientKind: "supplier",
      recipientId: supplierId,
      title: "New product request",
      body: `${buyerLabel(input.requesterSupplierId)} wants ${input.qty} × ${input.productName}. ${input.location.fulfilmentType === "pickup" ? "Pickup" : "Delivery"} requested: ${input.deliveryAt.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" })} SAST. ${input.location.fulfilmentType === "pickup" ? "Pickup search area" : "Delivery address"}: ${input.location.address}, ${input.location.city}, ${input.location.province}. Accept to open checkout.`,
      kind: "purchase_request",
      refType: "purchase_request",
      refId: input.requestId,
    });
  }
}

export async function createPurchaseRequestFor(
  session: SessionLike,
  data: { wcProductId: number; qty?: number; productName?: string; targetSupplierId?: string | null; deliveryAt?: string; location?: RequestLocation },
  ip?: string,
) {
  const requester = requesterOf(session);
  const deliveryAt = validateDeliveryAt(data.deliveryAt);
  const location = requestLocation(data.location);

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

  const supplierIds = await targetsForSelection(session, wcProductId, qty, location, data.targetSupplierId);
  if (!supplierIds.length) {
    throw validationError(
      requester.supplierId
        ? "No other companies have enough stock in the selected city."
        : "No suppliers currently have enough stock of this product in the selected city.",
    );
  }

  const id = makeId("prq");
  const row = await insertPurchaseRequest({
    id,
    customer_wp_user_id: requester.principal.wpUserId,
    customer_email: normalizeEmail(requester.principal.email),
    requester_supplier_id: requester.supplierId,
    target_supplier_id: data.targetSupplierId || null,
    wc_product_id: wcProductId,
    product_name: productName,
    qty,
    window_minutes: PURCHASE_REQUEST_ACCEPT_WINDOW_MINUTES,
    delivery_at: deliveryAt,
    location,
  });
  await insertPurchaseOffers(id, supplierIds);
  await notifySuppliers({
    requestId: id,
    supplierIds,
    qty,
    productName,
    requesterSupplierId: requester.supplierId,
    deliveryAt,
    location,
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
  const accepted = await acceptPurchaseRequest(id, scope, (current) =>
    buildCheckoutUrl(Number(current.wc_product_id), Number(current.qty), current.id),
    async (current, supplier, connection) => {
      const location = requestLocation(mapRequest(current).location);
      const stocking = await listStockingSupplierIds(Number(current.wc_product_id), Number(current.qty), connection);
      if (!stocking.includes(scope) || !supplierServesLocation(supplier, location)) {
        throw validationError("The product stock or supplier city has changed. This request can no longer be accepted.");
      }
    },
  );

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
  if (!row.accepted_supplier_id || (row.status !== "accepted" && row.status !== "checkout_started")) {
    throw validationError("Wait for a company to accept before paying.");
  }
  const updated = await markCheckoutStarted(id);
  return mapRequest(updated, { includeCheckoutUrl: true });
}

export async function cancelPurchaseRequestFor(session: SessionLike, id: string, ip?: string) {
  const requester = requesterOf(session);
  const row = await findPurchaseRequestById(id);
  if (!row) throw notFound("That request is not available.");
  if (!ownsRequest(row, requester) || (!requester.supplierId && row.requester_supplier_id)) throw accessDenied();
  const cancelled = await cancelPurchaseRequest(id, { customerWpUserId: requester.principal.wpUserId!, supplierId: requester.supplierId });
  if (row.status !== "cancelled") {
    if (cancelled.accepted_supplier_id) await insertNotification({ recipientKind: "supplier", recipientId: cancelled.accepted_supplier_id,
      title: "Request cancelled", body: `The buyer cancelled their request for ${cancelled.qty} × ${cancelled.product_name}.`,
      kind: "purchase_cancelled", refType: "purchase_request", refId: id });
    await writeAudit({ session, action: "purchase_request.cancel", targetType: "purchase_request", targetId: id, ip, after: mapRequest(cancelled) });
  }
  return mapRequest(cancelled);
}

export async function resendPurchaseRequestFor(
  session: SessionLike,
  id: string,
  data: { qty?: number; targetSupplierId?: string | null; deliveryAt?: string; location?: RequestLocation } = {},
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

  const location = requestLocation(data.location ?? mapRequest(row).location);
  const deliveryAt = validateDeliveryAt(data.deliveryAt ?? (row.delivery_at ? new Date(row.delivery_at).toISOString() : undefined));
  const qty = Math.max(1, Math.floor(Number(data.qty) || Number(row.qty) || 1));
  const targetSupplierId = data.targetSupplierId === undefined ? row.target_supplier_id : data.targetSupplierId;
  const supplierIds = await targetsForSelection(session, Number(row.wc_product_id), qty, location, targetSupplierId);
  if (!supplierIds.length) {
    throw validationError(
      requester.supplierId
        ? "No other companies have enough stock in the selected city."
        : "No suppliers currently have enough stock of this product in the selected city.",
    );
  }

  const updated = await resendPurchaseRequest({
    requestId: id,
    qty,
    windowMinutes: PURCHASE_REQUEST_ACCEPT_WINDOW_MINUTES,
    location,
    deliveryAt,
    targetSupplierId: targetSupplierId || null,
    supplierIds,
  });
  await notifySuppliers({
    requestId: id,
    supplierIds,
    qty,
    productName: row.product_name,
    requesterSupplierId: requester.supplierId,
    deliveryAt,
    location,
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
  lineItems: { product_id: number; quantity: number }[];
}): Promise<{ ok: boolean; reason?: string }> {
  const row = await findPurchaseRequestById(input.requestId);
  if (!row) return { ok: false, reason: "request_not_found" };
  if (!["accepted", "checkout_started"].includes(row.status) || !row.accepted_supplier_id) {
    return { ok: false, reason: "request_not_accepted" };
  }
  if (input.lineItems.length !== 1 || Number(input.lineItems[0]?.product_id) !== Number(row.wc_product_id)
    || Number(input.lineItems[0]?.quantity) !== Number(row.qty)) {
    return { ok: false, reason: "items_mismatch" };
  }

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
