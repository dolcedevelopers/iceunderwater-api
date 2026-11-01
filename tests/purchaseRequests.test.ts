import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/authz/permissions.js";
import * as requests from "../src/repositories/purchaseRequestRepo.js";
import * as suppliers from "../src/repositories/supplierRepo.js";
import { createPurchaseRequestFor, listPurchaseSuppliersFor, resendPurchaseRequestFor,
  startCheckoutFor, fulfillPurchaseRequestFromOrder } from "../src/services/purchaseRequestService.js";

vi.mock("../src/repositories/purchaseRequestRepo.js", () => ({
  acceptPurchaseRequest: vi.fn(), expireStalePurchaseRequests: vi.fn(), findPurchaseRequestById: vi.fn(),
  insertPurchaseOffers: vi.fn(), insertPurchaseRequest: vi.fn(), listPurchaseRequests: vi.fn(),
  markCheckoutStarted: vi.fn(), markPurchaseRequestPaid: vi.fn(), resendPurchaseRequest: vi.fn(),
}));
vi.mock("../src/repositories/supplierRepo.js", () => ({ listSuppliers: vi.fn() }));
vi.mock("../src/repositories/auditRepo.js", () => ({ writeAudit: vi.fn() }));
vi.mock("../src/repositories/notificationRepo.js", () => ({ insertNotification: vi.fn() }));
vi.mock("../src/clients/woocommerce.js", () => ({ getWcProduct: vi.fn(async () => ({ name: "Water" })) }));

const customer: Principal = { sub: 1, wpUserId: 1, role: "customer", email: "buyer@example.com" };
const company: Principal = { ...customer, role: "supplier", supplierId: "own" };
function row(changes: Record<string, unknown> = {}) {
  return { id: "req", customer_wp_user_id: 1, customer_email: customer.email, requester_supplier_id: null,
    target_supplier_id: null, wc_product_id: 5, product_name: "Water", qty: 2, status: "open",
    accepted_supplier_id: null, checkout_url: "", created_at: new Date(), ...changes } as requests.PurchaseRequestRow;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(suppliers.listSuppliers).mockResolvedValue([
    { id: "own", name: "Own", city: "JHB" }, { id: "a", name: "A", city: "JHB" },
    { id: "b", name: "B", city: "Cape Town" },
  ] as never);
  vi.mocked(requests.listPurchaseRequests).mockResolvedValue([]);
  vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row());
  vi.mocked(requests.insertPurchaseRequest).mockImplementation(async (input) => row(input));
  vi.mocked(requests.resendPurchaseRequest).mockResolvedValue(row());
  vi.mocked(requests.markPurchaseRequestPaid).mockResolvedValue(true);
});

describe("supplier routing for individual and company buyers", () => {
  it.each([customer, company])("sends a selected supplier only ($role)", async (buyer) => {
    await createPurchaseRequestFor(buyer, { wcProductId: 5, qty: 2, targetSupplierId: "a" });
    expect(requests.insertPurchaseOffers).toHaveBeenCalledWith(expect.any(String), ["a"]);
    expect(requests.insertPurchaseRequest).toHaveBeenCalledWith(expect.objectContaining({ target_supplier_id: "a" }));
  });
  it("sends All to every active supplier and excludes the requesting company", async () => {
    await createPurchaseRequestFor(company, { wcProductId: 5, targetSupplierId: null });
    expect(suppliers.listSuppliers).toHaveBeenCalledWith({ status: "active" });
    expect(requests.insertPurchaseOffers).toHaveBeenCalledWith(expect.any(String), ["a", "b"]);
  });
  it.each(["own", "unknown"])("rejects an unavailable or own supplier %s", async (targetSupplierId) => {
    await expect(createPurchaseRequestFor(company, { wcProductId: 5, targetSupplierId })).rejects.toThrow();
    expect(requests.insertPurchaseRequest).not.toHaveBeenCalled();
  });
  it("marks previous suppliers from this customer's paid orders only", async () => {
    vi.mocked(requests.listPurchaseRequests).mockResolvedValue([
      row({ status: "paid", accepted_supplier_id: "a" }),
      row({ status: "accepted", accepted_supplier_id: "b" }),
    ]);
    const result = await listPurchaseSuppliersFor(customer);
    expect(result.find((item) => item.id === "a")?.previous).toBe(true);
    expect(result.find((item) => item.id === "b")?.previous).toBe(false);
    expect(requests.listPurchaseRequests).toHaveBeenCalledWith({ customerWpUserId: 1 });
  });
  it("does not use incoming company requests as supplier history", async () => {
    vi.mocked(requests.listPurchaseRequests).mockResolvedValue([
      row({ status: "paid", accepted_supplier_id: "a", requester_supplier_id: "another-company" }),
      row({ status: "paid", accepted_supplier_id: "b", requester_supplier_id: "own" }),
    ]);
    const result = await listPurchaseSuppliersFor(company);
    expect(result.find((item) => item.id === "a")?.previous).toBe(false);
    expect(result.find((item) => item.id === "b")?.previous).toBe(true);
  });
  it("retains the selected supplier on resend", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ target_supplier_id: "a" }));
    await resendPurchaseRequestFor(customer, "req", { qty: 4 });
    expect(requests.resendPurchaseRequest).toHaveBeenCalledWith(expect.objectContaining({
      targetSupplierId: "a", supplierIds: ["a"], qty: 4,
    }));
  });
  it("can explicitly resend to All", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ target_supplier_id: "a" }));
    await resendPurchaseRequestFor(customer, "req", { targetSupplierId: null });
    expect(requests.resendPurchaseRequest).toHaveBeenCalledWith(expect.objectContaining({
      targetSupplierId: null, supplierIds: ["own", "a", "b"],
    }));
  });
});

describe("acceptance before payment", () => {
  it.each(["open", "expired", "cancelled", "paid"])("blocks checkout for %s requests", async (status) => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status }));
    await expect(startCheckoutFor(customer, "req")).rejects.toThrow();
    expect(requests.markCheckoutStarted).not.toHaveBeenCalled();
  });
  it("blocks another buyer from paying an accepted request", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status: "accepted", customer_wp_user_id: 2 }));
    await expect(startCheckoutFor(customer, "req")).rejects.toThrow();
  });
  it.each([customer, company])("allows the requesting $role to pay after acceptance", async (buyer) => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status: "accepted", accepted_supplier_id: "a",
      requester_supplier_id: buyer.supplierId || null, checkout_url: "https://iceunderwater.co.za/checkout/?iuw_request_id=req" }));
    expect((await startCheckoutFor(buyer, "req")).checkoutUrl).toContain("iuw_request_id=req");
  });
  const payment = { requestId: "req", customerWpUserId: 1, customerEmail: customer.email,
    wooOrderId: 10, wooOrderNumber: "10", lineItems: [{ product_id: 5, quantity: 2 }] };
  it.each(["open", "expired", "cancelled"])("cannot reconcile payment for a %s request", async (status) => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status }));
    expect((await fulfillPurchaseRequestFromOrder(payment)).ok).toBe(false);
    expect(requests.markPurchaseRequestPaid).not.toHaveBeenCalled();
  });
  it("rejects payment for different items or quantities", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status: "accepted", accepted_supplier_id: "a" }));
    expect((await fulfillPurchaseRequestFromOrder({ ...payment, lineItems: [{ product_id: 5, quantity: 1 }] })).ok).toBe(false);
  });
  it("confirms matching payment only after acceptance", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status: "accepted", accepted_supplier_id: "a" }));
    expect((await fulfillPurchaseRequestFromOrder(payment)).ok).toBe(true);
  });
});
