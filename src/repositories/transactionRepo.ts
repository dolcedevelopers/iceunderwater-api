import type { RowDataPacket } from "mysql2";
import { execute, query } from "../db/pool.js";

export type TransactionRow = RowDataPacket & {
  id: string;
  wc_order_id: number;
  reference: string;
  customer_wp_user_id: number | null;
  customer_name: string;
  customer_email: string;
  supplier_id: string;
  supplier_name: string;
  items: number;
  total_cents: number;
  status: "paid" | "pending" | "refunded" | "failed";
  method: string;
  created_at: Date;
  receipt_sent_at: Date | null;
  deleted_at: Date | null;
};

export type TransactionLineRow = RowDataPacket & {
  id: number;
  transaction_id: string;
  wc_product_id: number | null;
  supplier_id: string;
  name: string;
  quantity: number;
  line_total_cents: number;
};

export async function findTransactionById(id: string): Promise<TransactionRow | null> {
  const rows = await query<TransactionRow[]>(
    `SELECT * FROM iuw_transactions WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

export async function findTransactionByReference(reference: string): Promise<TransactionRow | null> {
  const rows = await query<TransactionRow[]>(
    `SELECT * FROM iuw_transactions WHERE reference = :reference AND deleted_at IS NULL LIMIT 1`,
    { reference },
  );
  return rows[0] || null;
}

export async function findTransactionByOrderId(wcOrderId: number): Promise<TransactionRow | null> {
  const rows = await query<TransactionRow[]>(
    `SELECT * FROM iuw_transactions WHERE wc_order_id = :wcOrderId AND deleted_at IS NULL LIMIT 1`,
    { wcOrderId },
  );
  return rows[0] || null;
}

export async function listTransactions(filter: {
  supplierId?: string | null;
  customerEmail?: string;
  customerWpUserId?: number;
  reference?: string;
}): Promise<TransactionRow[]> {
  if (filter.supplierId) {
    // Supplier scope uses line ownership so multi-supplier orders remain visible for their share.
    return query<TransactionRow[]>(
      `SELECT DISTINCT t.* FROM iuw_transactions t
       INNER JOIN iuw_transaction_lines l ON l.transaction_id = t.id
       WHERE t.deleted_at IS NULL AND l.supplier_id = :supplierId
       ${filter.reference ? "AND t.reference = :reference" : ""}
       ORDER BY t.created_at DESC`,
      { supplierId: filter.supplierId, reference: filter.reference },
    );
  }

  const clauses = ["deleted_at IS NULL"];
  const params: Record<string, unknown> = {};
  if (filter.customerEmail) {
    clauses.push("customer_email = :customerEmail");
    params.customerEmail = filter.customerEmail;
  }
  if (filter.customerWpUserId) {
    clauses.push("customer_wp_user_id = :customerWpUserId");
    params.customerWpUserId = filter.customerWpUserId;
  }
  if (filter.reference) {
    clauses.push("reference = :reference");
    params.reference = filter.reference;
  }
  return query<TransactionRow[]>(
    `SELECT * FROM iuw_transactions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
    params,
  );
}

export async function upsertTransaction(row: {
  id: string;
  wc_order_id: number;
  reference: string;
  customer_wp_user_id: number | null;
  customer_name: string;
  customer_email: string;
  supplier_id: string;
  supplier_name: string;
  items: number;
  total_cents: number;
  status: TransactionRow["status"];
  method: string;
  created_at?: Date | null;
}): Promise<TransactionRow> {
  const existing = await findTransactionByOrderId(row.wc_order_id);
  if (existing) {
    await execute(
      `UPDATE iuw_transactions SET
        reference = :reference,
        customer_wp_user_id = :customer_wp_user_id,
        customer_name = :customer_name,
        customer_email = :customer_email,
        supplier_id = :supplier_id,
        supplier_name = :supplier_name,
        items = :items,
        total_cents = :total_cents,
        status = :status,
        method = :method
       WHERE id = :id`,
      { ...row, id: existing.id },
    );
    await execute(`DELETE FROM iuw_transaction_lines WHERE transaction_id = :id`, { id: existing.id });
    const updated = await findTransactionById(existing.id);
    if (!updated) throw new Error(`Transaction ${existing.id} missing after update`);
    return updated;
  }

  await execute(
    `INSERT INTO iuw_transactions
      (id, wc_order_id, reference, customer_wp_user_id, customer_name, customer_email,
       supplier_id, supplier_name, items, total_cents, status, method, created_at)
     VALUES
      (:id, :wc_order_id, :reference, :customer_wp_user_id, :customer_name, :customer_email,
       :supplier_id, :supplier_name, :items, :total_cents, :status, :method, COALESCE(:created_at, UTC_TIMESTAMP(3)))`,
    {
      ...row,
      created_at: row.created_at ?? null,
      customer_wp_user_id: row.customer_wp_user_id ?? null,
    },
  );
  const created = await findTransactionById(row.id);
  if (!created) throw new Error(`Transaction ${row.id} missing after insert`);
  return created;
}

export async function insertTransactionLines(
  lines: {
    transaction_id: string;
    wc_product_id: number | null;
    supplier_id: string;
    name: string;
    quantity: number;
    line_total_cents: number;
  }[],
): Promise<void> {
  for (const line of lines) {
    await execute(
      `INSERT INTO iuw_transaction_lines
        (transaction_id, wc_product_id, supplier_id, name, quantity, line_total_cents)
       VALUES
        (:transaction_id, :wc_product_id, :supplier_id, :name, :quantity, :line_total_cents)`,
      line,
    );
  }
}

export async function updateTransactionStatus(
  id: string,
  status: TransactionRow["status"],
): Promise<TransactionRow | null> {
  await execute(`UPDATE iuw_transactions SET status = :status WHERE id = :id AND deleted_at IS NULL`, { id, status });
  return findTransactionById(id);
}

export async function markReceiptSent(id: string, sentAt: Date): Promise<TransactionRow | null> {
  await execute(`UPDATE iuw_transactions SET receipt_sent_at = :sentAt WHERE id = :id AND deleted_at IS NULL`, {
    id,
    sentAt,
  });
  return findTransactionById(id);
}

export async function supplierSettlement(supplierId: string): Promise<{
  paidCents: number;
  pendingCents: number;
  refundedCents: number;
  orderCount: number;
}> {
  const rows = await query<(RowDataPacket & { status: string; cents: number; orders: number })[]>(
    `SELECT t.status AS status, COALESCE(SUM(l.line_total_cents), 0) AS cents, COUNT(DISTINCT t.id) AS orders
     FROM iuw_transaction_lines l
     INNER JOIN iuw_transactions t ON t.id = l.transaction_id
     WHERE l.supplier_id = :supplierId AND t.deleted_at IS NULL
     GROUP BY t.status`,
    { supplierId },
  );
  const out = { paidCents: 0, pendingCents: 0, refundedCents: 0, orderCount: 0 };
  for (const row of rows) {
    out.orderCount += Number(row.orders);
    if (row.status === "paid") out.paidCents += Number(row.cents);
    if (row.status === "pending") out.pendingCents += Number(row.cents);
    if (row.status === "refunded") out.refundedCents += Number(row.cents);
  }
  return out;
}
