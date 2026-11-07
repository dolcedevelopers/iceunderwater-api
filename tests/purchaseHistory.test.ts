import { beforeEach, expect, it, vi } from "vitest";
import { purchaseHistoryFor } from "../src/services/purchaseHistoryService.js";
import { listTransactionsFor } from "../src/services/transactionService.js";
import { listPurchaseRequestsFor } from "../src/services/purchaseRequestService.js";
import type { Principal } from "../src/authz/permissions.js";
vi.mock("../src/services/transactionService.js", () => ({ listTransactionsFor: vi.fn() }));
vi.mock("../src/services/purchaseRequestService.js", () => ({ listPurchaseRequestsFor: vi.fn() }));
const customer: Principal = { sub: 11, wpUserId: 11, email: "buyer@example.com", role: "customer" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listPurchaseRequestsFor).mockResolvedValue([
    { id: "past", customerWpUserId: 11, status: "expired" },
    { id: "cancelled", customerWpUserId: 11, status: "cancelled" },
    { id: "other", customerWpUserId: 99, status: "paid" },
  ] as never);
  vi.mocked(listTransactionsFor).mockResolvedValue([
    { id: "own", customerId: "11", customerEmail: "old@example.com" },
    { id: "guest", customerId: "", customerEmail: "buyer@example.com" },
    { id: "foreign", customerId: "99", customerEmail: "buyer@example.com" },
  ] as never);
});
it("retains expired and cancelled history, including own purchases and legacy guest purchases", async () => {
  const result = await purchaseHistoryFor(customer);
  expect(result.requests.map((row) => row.id)).toEqual(["past", "cancelled"]);
  expect(result.purchases.map((row) => row.id)).toEqual(["own", "guest"]);
});
it("excludes incoming sales from a company's purchase history", async () => {
  vi.mocked(listPurchaseRequestsFor).mockResolvedValue([
    { id: "outgoing", requesterSupplierId: "a" }, { id: "incoming", requesterSupplierId: "b" },
  ] as never);
  vi.mocked(listTransactionsFor).mockResolvedValue([
    { id: "purchase", transactionType: "purchase" }, { id: "sale", transactionType: "sale" },
  ] as never);
  const result = await purchaseHistoryFor({ ...customer, role: "supplier", supplierId: "a" });
  expect(result.requests.map((row) => row.id)).toEqual(["outgoing"]);
  expect(result.purchases.map((row) => row.id)).toEqual(["purchase"]);
});
it.each([null, { ...customer, role: "driver" }, { ...customer, role: "admin" }])("does not expose buyer history to other roles", async (principal) => {
  await expect(purchaseHistoryFor(principal as Principal | null)).rejects.toThrow();
  expect(listPurchaseRequestsFor).not.toHaveBeenCalled();
});
