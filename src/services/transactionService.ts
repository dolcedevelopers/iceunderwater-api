import {
  canAccessTransaction,
  identityEmail,
  isAdmin,
  isCustomer,
  isSupplier,
  requireAdmin,
  requireSignedIn,
  requireTransactionAccess,
  resolveSupplierScope,
  type SessionLike,
} from "../authz/permissions.js";
import { accessDenied, validationError } from "../lib/errors.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { randsToCents } from "../lib/money.js";
import { mapTransaction, type SupplierInvoiceIdentity, type TransactionDto } from "../serializers/dto.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  findProductOwner,
} from "../repositories/productRepo.js";
import { findSupplierById, listSuppliers, type SupplierRow } from "../repositories/supplierRepo.js";
import {
  findTransactionById,
  findTransactionByReference,
  insertTransactionLines,
  listTransactions,
  markReceiptSent,
  updateTransactionStatus,
  upsertTransaction,
  type TransactionRow,
} from "../repositories/transactionRepo.js";
import { createWcRefund, updateWcOrderStatus } from "../clients/woocommerce.js";
import { sendWcInvoice } from "../clients/wordpress.js";
import { execute } from "../db/pool.js";

export function mapWooStatus(status: string | undefined | null): "paid" | "pending" | "refunded" | "failed" {
  const s = String(status || "pending").replace(/^wc-/, "");
  switch (s) {
    case "completed":
    case "processing":
      return "paid";
    case "refunded":
      return "refunded";
    case "failed":
    case "cancelled":
      return "failed";
    case "pending":
    case "on-hold":
      return "pending";
    default:
      return "pending";
  }
}

function invoiceIdentityOf(supplier: SupplierRow | null | undefined): SupplierInvoiceIdentity | null {
  if (!supplier) return null;
  return {
    vatNumber: supplier.vat_number || "",
    registrationNumber: supplier.registration_number || "",
    address: supplier.address || "",
  };
}

/**
 * A generated invoice has to print the seller's VAT number, company
 * registration number and trading address, so every receipt is hydrated from
 * the supplier record before it leaves the API.
 */
async function toInvoices(rows: TransactionRow[]): Promise<TransactionDto[]> {
  const wanted = new Set(rows.map((row) => row.supplier_id).filter(Boolean));
  if (!wanted.size) return rows.map((row) => mapTransaction(row));
  const identities = new Map<string, SupplierInvoiceIdentity>();
  for (const supplier of await listSuppliers({})) {
    if (wanted.has(supplier.id)) identities.set(supplier.id, invoiceIdentityOf(supplier)!);
  }
  return rows.map((row) => mapTransaction(row, identities.get(row.supplier_id) || null));
}

async function toInvoice(row: TransactionRow): Promise<TransactionDto> {
  const supplier = row.supplier_id ? await findSupplierById(row.supplier_id) : null;
  return mapTransaction(row, invoiceIdentityOf(supplier));
}

export async function listTransactionsFor(
  session: SessionLike,
  opts: { supplierId?: string; reference?: string } = {},
) {
  requireSignedIn(session);

  if (isAdmin(session)) {
    const rows = await listTransactions({
      supplierId: opts.supplierId || null,
      reference: opts.reference,
    });
    return toInvoices(rows);
  }

  if (isSupplier(session)) {
    const scope = resolveSupplierScope(session, opts.supplierId);
    const rows = await listTransactions({ supplierId: scope, reference: opts.reference });
    return toInvoices(rows);
  }

  if (isCustomer(session)) {
    const rows = await listTransactions({
      customerEmail: identityEmail(session),
      reference: opts.reference,
    });
    return toInvoices(
      rows.filter((row) =>
        canAccessTransaction(session, {
          supplierId: row.supplier_id,
          customerEmail: row.customer_email,
          customerId: row.customer_wp_user_id,
        }),
      ),
    );
  }

  throw accessDenied();
}

export async function getTransactionFor(session: SessionLike, id: string) {
  requireSignedIn(session);
  const row = await findTransactionById(id);
  requireTransactionAccess(session, row ? {
    supplierId: row.supplier_id,
    customerEmail: row.customer_email,
    customerId: row.customer_wp_user_id,
  } : null);
  return toInvoice(row!);
}

export async function listMyReceipts(session: SessionLike) {
  return listTransactionsFor(session);
}

export async function updateTransactionFor(
  session: SessionLike,
  id: string,
  changes: { status?: "paid" | "pending" | "refunded" | "failed" },
  ip?: string,
) {
  requireAdmin(session);
  const existing = await findTransactionById(id);
  if (!existing) throw accessDenied("That receipt is not available.");
  if (!changes.status) throw validationError("status is required");

  if (changes.status === "refunded") {
    await createWcRefund(existing.wc_order_id);
  } else if (changes.status === "paid") {
    await updateWcOrderStatus(existing.wc_order_id, "processing");
  } else if (changes.status === "failed") {
    await updateWcOrderStatus(existing.wc_order_id, "failed");
  }

  const updated = await updateTransactionStatus(id, changes.status);
  await writeAudit({
    session,
    action: "transaction.update",
    targetType: "transaction",
    targetId: id,
    ip,
    before: mapTransaction(existing),
    after: updated ? mapTransaction(updated) : null,
  });
  return updated ? toInvoice(updated) : null;
}

export async function sendReceiptFor(session: SessionLike, id: string, ip?: string) {
  requireSignedIn(session);
  const existing = await findTransactionById(id);
  requireTransactionAccess(session, existing ? {
    supplierId: existing.supplier_id,
    customerEmail: existing.customer_email,
    customerId: existing.customer_wp_user_id,
  } : null);

  await execute(
    `INSERT INTO iuw_email_jobs (wc_order_id, transaction_id, status, next_attempt_at)
     VALUES (:orderId, :txId, 'queued', UTC_TIMESTAMP(3))`,
    { orderId: existing!.wc_order_id, txId: existing!.id },
  );

  try {
    await sendWcInvoice(existing!.wc_order_id);
    const sentAt = new Date();
    await markReceiptSent(existing!.id, sentAt);
    await execute(
      `UPDATE iuw_email_jobs SET status = 'sent', sent_at = :sentAt, attempts = attempts + 1
       WHERE transaction_id = :txId ORDER BY id DESC LIMIT 1`,
      { sentAt, txId: existing!.id },
    );
    await writeAudit({
      session,
      action: "transaction.receipt",
      targetType: "transaction",
      targetId: id,
      ip,
    });
    return {
      transactionId: id,
      sentAt: sentAt.toISOString(),
      to: existing!.customer_email,
      queued: true,
    };
  } catch (error) {
    await execute(
      `UPDATE iuw_email_jobs SET status = 'failed', attempts = attempts + 1, last_error = :err,
        next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE)
       WHERE transaction_id = :txId ORDER BY id DESC LIMIT 1`,
      { err: error instanceof Error ? error.message : "send failed", txId: existing!.id },
    );
    throw error;
  }
}

/** WooCommerce webhook / poll sync — never trust a client-invented paid order. */
export async function syncWooOrder(order: {
  id: number | string;
  number?: string | number;
  status?: string;
  currency?: string;
  total?: string;
  date_created?: string;
  billing?: { email?: string; first_name?: string; last_name?: string };
  customer_id?: number;
  payment_method_title?: string;
  meta_data?: { key?: string; value?: unknown }[];
  line_items?: {
    product_id: number;
    name: string;
    quantity: number;
    total: string;
  }[];
}) {
  const orderId = Number(order.id);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw validationError("Invalid order id.");
  }

  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  const enriched = [];
  for (const line of lines) {
    const productId = Number(line.product_id);
    const owner = Number.isFinite(productId) ? await findProductOwner(productId) : null;
    enriched.push({
      wc_product_id: Number.isFinite(productId) ? productId : null,
      supplier_id: owner?.supplier_id || "",
      name: String(line.name || "Item"),
      quantity: Number(line.quantity) || 0,
      line_total_cents: randsToCents(Number(line.total) || 0),
    });
  }

  const bySupplier = new Map<string, number>();
  for (const line of enriched) {
    if (!line.supplier_id) continue;
    bySupplier.set(line.supplier_id, (bySupplier.get(line.supplier_id) || 0) + line.line_total_cents);
  }
  let primarySupplierId = "";
  let primaryCents = -1;
  for (const [sid, cents] of bySupplier) {
    if (cents > primaryCents) {
      primarySupplierId = sid;
      primaryCents = cents;
    }
  }
  const supplier = primarySupplierId ? await findSupplierById(primarySupplierId) : null;

  const status = mapWooStatus(order.status);
  const tx = await upsertTransaction({
    id: makeId("trx"),
    wc_order_id: orderId,
    reference: String(order.number || orderId),
    customer_wp_user_id: order.customer_id ? Number(order.customer_id) : null,
    customer_name: `${order.billing?.first_name || ""} ${order.billing?.last_name || ""}`.trim(),
    customer_email: normalizeEmail(order.billing?.email || ""),
    supplier_id: primarySupplierId,
    supplier_name: supplier?.name || "ICE UNDERWATER",
    items: lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0),
    total_cents: randsToCents(Number(order.total) || 0),
    status,
    method: order.payment_method_title || "Payfast",
    created_at: order.date_created ? new Date(order.date_created) : null,
  });

  await insertTransactionLines(
    enriched.map((line) => ({
      transaction_id: tx.id,
      ...line,
    })),
  );

  // Link accept-then-pay request when meta + customer match.
  if (status === "paid") {
    const meta = Array.isArray(order.meta_data) ? order.meta_data : [];
    const requestMeta = meta.find((item) => String(item.key || "") === "iuw_request_id");
    const requestId = String(requestMeta?.value || "").trim();
    if (requestId) {
      try {
        const { fulfillPurchaseRequestFromOrder } = await import("./purchaseRequestService.js");
        await fulfillPurchaseRequestFromOrder({
          requestId,
          customerWpUserId: order.customer_id ? Number(order.customer_id) : null,
          customerEmail: normalizeEmail(order.billing?.email || ""),
          wooOrderId: orderId,
          wooOrderNumber: String(order.number || orderId),
        });
      } catch {
        // Do not fail webhook sync if purchase-request tables are missing/out of date.
      }
    }
  }

  // Auto-queue invoice on first sync when still pending receipt.
  // Never fail the webhook if the mail queue insert has a problem.
  if (!tx.receipt_sent_at) {
    try {
      await execute(
        `INSERT INTO iuw_email_jobs (wc_order_id, transaction_id, status)
         VALUES (:orderId, :txId, 'queued')`,
        { orderId, txId: tx.id },
      );
    } catch {
      // Delivery must still succeed; jobs can be retried later.
    }
  }

  return mapTransaction(tx);
}

export async function findByReferenceForClient(session: SessionLike, reference: string) {
  requireSignedIn(session);
  const row = await findTransactionByReference(reference);
  requireTransactionAccess(session, row ? {
    supplierId: row.supplier_id,
    customerEmail: row.customer_email,
    customerId: row.customer_wp_user_id,
  } : null);
  return toInvoice(row!);
}
