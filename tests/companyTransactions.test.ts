import { beforeEach, describe, expect, it, vi } from "vitest";
import * as repo from "../src/repositories/transactionRepo.js";
import * as suppliers from "../src/repositories/supplierRepo.js";
import { getTransactionFor, listMyReceipts, listTransactionsFor, sendReceiptFor, updateTransactionFor } from "../src/services/transactionService.js";
import { canAccessTransaction, type Principal } from "../src/authz/permissions.js";
import { execute } from "../src/db/pool.js";

vi.mock("../src/repositories/transactionRepo.js", async (original) => ({
  ...await original<typeof repo>(), listCompanyTransactions: vi.fn(), listTransactions: vi.fn(),
  findTransactionById: vi.fn(), markReceiptSent: vi.fn(),
}));
vi.mock("../src/repositories/supplierRepo.js", () => ({ listSuppliers: vi.fn(), findSupplierById: vi.fn() }));
vi.mock("../src/clients/wordpress.js", () => ({ sendWcInvoice: vi.fn() }));
vi.mock("../src/repositories/auditRepo.js", () => ({ writeAudit: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ execute: vi.fn(), query: vi.fn() }));

const company: Principal = { sub: 11, wpUserId: 11, role: "supplier", supplierId: "a", email: "a@example.com" };
const admin: Principal = { ...company, role: "admin", adminRole: "owner" };
function row(changes: Record<string, unknown> = {}) {
  return { id: "tx", wc_order_id: 10, reference: "ORDER10", customer_wp_user_id: 99,
    customer_name: "Buyer", customer_email: "buyer@example.com", supplier_id: "a", supplier_name: "Company A",
    items: 2, total_cents: 2500, status: "paid", method: "Payfast", created_at: new Date(),
    receipt_sent_at: null, transaction_type: "sale", line_items: [{ productId: 1, name: "Own product", quantity: 2, totalCents: 2500 }],
    ...changes } as repo.TransactionRow;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.listCompanyTransactions).mockResolvedValue([row()]);
  vi.mocked(repo.findTransactionById).mockResolvedValue(row());
  vi.mocked(repo.listTransactions).mockResolvedValue([row({ total_cents: 990000 })]);
  vi.mocked(suppliers.listSuppliers).mockResolvedValue([]);
  vi.mocked(suppliers.findSupplierById).mockResolvedValue(null);
});

describe("company transaction boundaries", () => {
  it("pins list scope to the token and never uses the unrestricted transaction query", async () => {
    const result = await listTransactionsFor(company);
    expect(repo.listCompanyTransactions).toHaveBeenCalledWith({ supplierId: "a", wpUserId: 11, reference: undefined });
    expect(repo.listTransactions).not.toHaveBeenCalled();
    expect(result[0]?.total).toBe(25);
    expect(result[0]?.lineItems).toEqual([{ productId: 1, name: "Own product", quantity: 2, total: 25 }]);
  });
  it("refuses a forged supplierId before reading any transactions", async () => {
    await expect(listTransactionsFor(company, { supplierId: "b" })).rejects.toMatchObject({ status: 403 });
    expect(repo.listCompanyTransactions).not.toHaveBeenCalled();
  });
  it("applies a reference search inside the company scope", async () => {
    await listTransactionsFor(company, { reference: "ORDER10" });
    expect(repo.listCompanyTransactions).toHaveBeenCalledWith({ supplierId: "a", wpUserId: 11, reference: "ORDER10" });
  });
  it("returns purchases made by the authenticated company with their seller identity", async () => {
    vi.mocked(repo.listCompanyTransactions).mockResolvedValue([row({ transaction_type: "purchase", customer_wp_user_id: 11,
      supplier_id: "b", supplier_name: "Company B", total_cents: 6000 })]);
    const result = await listTransactionsFor(company);
    expect(result[0]).toMatchObject({ transactionType: "purchase", supplierId: "b", customerId: "11", total: 60 });
  });
  it("uses scoped totals for direct transaction detail", async () => {
    const result = await getTransactionFor(company, "tx");
    expect(result.total).toBe(25);
    expect(repo.listCompanyTransactions).toHaveBeenCalledWith({ supplierId: "a", wpUserId: 11, id: "tx" });
    expect(repo.findTransactionById).not.toHaveBeenCalled();
  });
  it("denies a guessed foreign transaction id without exposing the full order", async () => {
    vi.mocked(repo.listCompanyTransactions).mockResolvedValue([]);
    await expect(getTransactionFor(company, "foreign")).rejects.toMatchObject({ status: 403 });
    expect(repo.findTransactionById).not.toHaveBeenCalled();
  });
  it("applies the same company scope to receipts and invoices", async () => {
    await listMyReceipts(company);
    expect(repo.listCompanyTransactions).toHaveBeenCalledWith({ supplierId: "a", wpUserId: 11, reference: undefined });
    expect(repo.listTransactions).not.toHaveBeenCalled();
  });
  it("blocks foreign receipt email before any queue mutation", async () => {
    vi.mocked(repo.listCompanyTransactions).mockResolvedValue([]);
    await expect(sendReceiptFor(company, "foreign")).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });
  it("sends a company purchase receipt only to the stored buyer email", async () => {
    vi.mocked(repo.listCompanyTransactions).mockResolvedValue([row({ transaction_type: "purchase", customer_wp_user_id: 11, supplier_id: "b" })]);
    vi.mocked(repo.findTransactionById).mockResolvedValue(row({ supplier_id: "b", customer_wp_user_id: 11, customer_email: "stored@example.com" }));
    expect((await sendReceiptFor(company, "tx")).to).toBe("stored@example.com");
  });
  it.each(["paid", "refunded"] as const)("does not grant companies admin status mutations (%s)", async (status) => {
    await expect(updateTransactionFor(company, "tx", { status })).rejects.toMatchObject({ status: 403 });
  });
  it("keeps the full transaction view for admins", async () => {
    expect((await listTransactionsFor(admin))[0]?.total).toBe(9900);
    expect(repo.listCompanyTransactions).not.toHaveBeenCalled();
  });
  it("requires authentication", async () => {
    await expect(listTransactionsFor(null)).rejects.toMatchObject({ status: 401 });
  });
  it("does not permit driver access", async () => {
    await expect(listTransactionsFor({ ...company, role: "driver" })).rejects.toMatchObject({ status: 403 });
  });
  it("recognizes company purchases by user id, never another company's email alone", () => {
    expect(canAccessTransaction(company, { supplierId: "b", customerId: 11, customerEmail: "changed@example.com" })).toBe(true);
    expect(canAccessTransaction(company, { supplierId: "b", customerId: 99, customerEmail: company.email })).toBe(false);
    expect(canAccessTransaction(company, { supplierId: "b", customerId: 99, customerEmail: "foreign@example.com" })).toBe(false);
  });
});
