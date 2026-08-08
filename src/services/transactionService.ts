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
import { mapTransaction } from "../serializers/dto.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  findProductOwner,
} from "../repositories/productRepo.js";
import { findSupplierById } from "../repositories/supplierRepo.js";
import {
  findTransactionById,
  findTransactionByReference,
  insertTransactionLines,
  listTransactions,
  markReceiptSent,
  updateTransactionStatus,
  upsertTransaction,
} from "../repositories/transactionRepo.js";
import { createWcRefund, updateWcOrderStatus } from "../clients/woocommerce.js";
import { sendWcInvoice } from "../clients/wordpress.js";
import { execute } from "../db/pool.js";

export function mapWooStatus(status: string): "paid" | "pending" | "refunded" | "failed" {
  const s = status.replace(/^wc-/, "");
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
    default:
      return "pending";
  }
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
    return rows.map(mapTransaction);
  }

  if (isSupplier(session)) {
    const scope = resolveSupplierScope(session, opts.supplierId);
    const rows = await listTransactions({ supplierId: scope, reference: opts.reference });
    return rows.map(mapTransaction);
  }

  if (isCustomer(session)) {
    const rows = await listTransactions({
      customerEmail: identityEmail(session),
      reference: opts.reference,
    });
    return rows.filter((row) => canAccessTransaction(session, {
      supplierId: row.supplier_id,
      customerEmail: row.customer_email,
      customerId: row.customer_wp_user_id,
    })).map(mapTransaction);
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
  return mapTransaction(row!);
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
  return updated ? mapTransaction(updated) : null;
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
  id: number;
  number?: string;
  status: string;
  currency?: string;
  total?: string;
  date_created?: string;
  billing?: { email?: string; first_name?: string; last_name?: string };
  customer_id?: number;
  payment_method_title?: string;
  line_items?: {
    product_id: number;
    name: string;
    quantity: number;
    total: string;
  }[];
}) {
  const lines = order.line_items || [];
  const enriched = [];
  for (const line of lines) {
    const owner = await findProductOwner(line.product_id);
    enriched.push({
      wc_product_id: line.product_id,
      supplier_id: owner?.supplier_id || "",
      name: line.name,
      quantity: line.quantity,
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

  const tx = await upsertTransaction({
    id: makeId("trx"),
    wc_order_id: order.id,
    reference: String(order.number || order.id),
    customer_wp_user_id: order.customer_id || null,
    customer_name: `${order.billing?.first_name || ""} ${order.billing?.last_name || ""}`.trim(),
    customer_email: normalizeEmail(order.billing?.email || ""),
    supplier_id: primarySupplierId,
    supplier_name: supplier?.name || "ICE UNDERWATER",
    items: lines.reduce((sum, l) => sum + Number(l.quantity || 0), 0),
    total_cents: randsToCents(Number(order.total) || 0),
    status: mapWooStatus(order.status),
    method: order.payment_method_title || "Payfast",
    created_at: order.date_created ? new Date(order.date_created) : undefined,
  });

  await insertTransactionLines(
    enriched.map((line) => ({
      transaction_id: tx.id,
      ...line,
    })),
  );

  // Auto-queue invoice on first sync when still pending receipt.
  if (!tx.receipt_sent_at) {
    await execute(
      `INSERT INTO iuw_email_jobs (wc_order_id, transaction_id, status)
       VALUES (:orderId, :txId, 'queued')`,
      { orderId: order.id, txId: tx.id },
    );
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
  return mapTransaction(row!);
}
