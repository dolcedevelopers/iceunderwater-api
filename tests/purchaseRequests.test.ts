import { listStockingSupplierIds } from "../src/repositories/productRepo.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/authz/permissions.js";
import * as requests from "../src/repositories/purchaseRequestRepo.js";
import { insertNotification } from "../src/repositories/notificationRepo.js";
import * as suppliers from "../src/repositories/supplierRepo.js";
import { createPurchaseRequestFor as createRaw, validateDeliveryAt, listPurchaseSuppliersFor, resendPurchaseRequestFor,
  matchPurchaseSuppliersFor, acceptPurchaseRequestFor, startCheckoutFor, fulfillPurchaseRequestFromOrder } from "../src/services/purchaseRequestService.js";

vi.mock("../src/repositories/purchaseRequestRepo.js", () => ({
  acceptPurchaseRequest: vi.fn(), expireStalePurchaseRequests: vi.fn(), findPurchaseRequestById: vi.fn(),
  insertPurchaseOffers: vi.fn(), insertPurchaseRequest: vi.fn(), listPurchaseRequests: vi.fn(),
  markCheckoutStarted: vi.fn(), markPurchaseRequestPaid: vi.fn(), resendPurchaseRequest: vi.fn(),
}));
vi.mock("../src/repositories/productRepo.js", () => ({ listStockingSupplierIds: vi.fn() }));
vi.mock("../src/repositories/supplierRepo.js", () => ({ listSuppliers: vi.fn() }));
vi.mock("../src/repositories/auditRepo.js", () => ({ writeAudit: vi.fn() }));
vi.mock("../src/repositories/notificationRepo.js", () => ({ insertNotification: vi.fn() }));
vi.mock("../src/clients/woocommerce.js", () => ({ getWcProduct: vi.fn(async () => ({ name: "Water" })) }));

const location = { address: "Johannesburg", latitude: -26.2041, longitude: 28.0473, fulfilmentType: "delivery" as const };
const deliveryAt = new Date(Date.now() + 86400000).toISOString();
const createPurchaseRequestFor: typeof createRaw = (session, data, ip) => createRaw(session, { deliveryAt, location, ...data }, ip);
const customer: Principal = { sub: 1, wpUserId: 1, role: "customer", email: "buyer@example.com" };
const company: Principal = { ...customer, role: "supplier", supplierId: "own" };
function row(changes: Record<string, unknown> = {}) {
  return { id: "req", customer_wp_user_id: 1, customer_email: customer.email, requester_supplier_id: null,
    location_address: location.address, location_latitude: location.latitude, location_longitude: location.longitude, fulfilment_type: location.fulfilmentType, delivery_at: new Date(deliveryAt), target_supplier_id: null, wc_product_id: 5, product_name: "Water", qty: 2, status: "open",
    accepted_supplier_id: null, checkout_url: "", created_at: new Date(), ...changes } as requests.PurchaseRequestRow;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listStockingSupplierIds).mockResolvedValue(["own", "a", "b"]);
  vi.mocked(suppliers.listSuppliers).mockResolvedValue([
    { id: "own", name: "Own", city: "JHB" }, { id: "a", name: "A", city: "JHB" },
    { id: "b", name: "B", city: "Cape Town" },
  ].map((supplier) => ({ ...supplier, latitude: location.latitude, longitude: location.longitude, service_radius_km: 25 })) as never);
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

describe("requested delivery schedule", () => {
  it.each([undefined, "invalid", "2099-02-30T12:00:00Z", "2020-01-01T12:00:00Z", "2026-12-05T12:00:00"])("rejects missing, invalid, past or ambiguous delivery %s", async (value) => {
    await expect(createRaw(customer, { wcProductId: 5, deliveryAt: value })).rejects.toThrow();
    expect(requests.insertPurchaseRequest).not.toHaveBeenCalled();
  });
  it("stores a future date as UTC and returns it to the requester", async () => {
    const result = await createRaw(customer, { wcProductId: 5, location, deliveryAt });
    expect(requests.insertPurchaseRequest).toHaveBeenCalledWith(expect.objectContaining({ delivery_at: new Date(deliveryAt) }));
    expect(result.deliveryAt).toBe(deliveryAt);
    expect(result.deliveryTimezone).toBe("Africa/Johannesburg");
    expect(insertNotification).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringMatching(/Delivery requested: .* SAST/) }));
    expect(validateDeliveryAt("2099-12-05T12:00:00+02:00").toISOString()).toBe("2099-12-05T10:00:00.000Z");
  });
  it("keeps the schedule on resend unless the owner chooses a new one", async () => {
    await resendPurchaseRequestFor(customer, "req", { qty: 4 });
    expect(requests.resendPurchaseRequest).toHaveBeenCalledWith(expect.objectContaining({ deliveryAt: new Date(deliveryAt) }));
    const changed = new Date(Date.now() + 172800000).toISOString();
    await resendPurchaseRequestFor(customer, "req", { deliveryAt: changed });
    expect(requests.resendPurchaseRequest).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryAt: new Date(changed) }));
  });
  it("requires a new schedule for an old unscheduled request", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ delivery_at: null }));
    await expect(resendPurchaseRequestFor(customer,"req")).rejects.toThrow();
    expect(requests.resendPurchaseRequest).not.toHaveBeenCalled();
  });
  it("cannot alter another buyer's or an accepted request's schedule", async () => {
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ customer_wp_user_id: 2 }));
    await expect(resendPurchaseRequestFor(customer,"req",{ deliveryAt })).rejects.toThrow();
    vi.mocked(requests.findPurchaseRequestById).mockResolvedValue(row({ status: "accepted" }));
    await expect(resendPurchaseRequestFor(customer,"req",{ deliveryAt })).rejects.toThrow();
    expect(requests.resendPurchaseRequest).not.toHaveBeenCalled();
  });
});


describe("stock and supplier-defined service radius", () => {
  it("notifies only exact-product stock owners within range", async () => {
    vi.mocked(listStockingSupplierIds).mockResolvedValue(["a", "b"]);
    vi.mocked(suppliers.listSuppliers).mockResolvedValue([
      { id: "a", latitude: location.latitude, longitude: location.longitude, service_radius_km: 10 },
      { id: "b", latitude: -33.925, longitude: 18.424, service_radius_km: 20 },
      { id: "nearby-non-owner", latitude: location.latitude, longitude: location.longitude, service_radius_km: 50 },
    ] as never);
    await createPurchaseRequestFor(customer, { wcProductId: 5, qty: 4 });
    expect(listStockingSupplierIds).toHaveBeenCalledWith(5, 4);
    expect(requests.insertPurchaseOffers).toHaveBeenCalledWith(expect.any(String), ["a"]);
    expect(insertNotification).toHaveBeenCalledTimes(1);
    expect(insertNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "a" }));
  });
  it("fails closed for unavailable stock or unconfigured service area", async () => {
    vi.mocked(listStockingSupplierIds).mockResolvedValue([]);
    await expect(createPurchaseRequestFor(customer, { wcProductId: 5 })).rejects.toThrow();
    vi.mocked(listStockingSupplierIds).mockResolvedValue(["a"]);
    vi.mocked(suppliers.listSuppliers).mockResolvedValue([{ id: "a" }] as never);
    await expect(createPurchaseRequestFor(customer, { wcProductId: 5 })).rejects.toThrow();
    expect(insertNotification).not.toHaveBeenCalled();
  });
  it("supports All for a mixed basket without suggesting a supplier who lacks an item", async () => {
    vi.mocked(listStockingSupplierIds).mockImplementation(async (id) => id === 5 ? ["a"] : ["b"]);
    const result = await matchPurchaseSuppliersFor(customer, { items: [{ wcProductId: 5, qty: 1 }, { wcProductId: 6, qty: 1 }], location });
    expect(result.allAvailable).toBe(true);
    expect(result.suppliers).toEqual([]);
  });
  it("uses the pickup search address and rejects a selected supplier outside its range", async () => {
    await createPurchaseRequestFor(customer, { wcProductId: 5, location: { ...location, fulfilmentType: "pickup" }, targetSupplierId: "a" });
    expect(insertNotification).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("Pickup search area: Johannesburg") }));
    await expect(createPurchaseRequestFor(customer, { wcProductId: 5, location: { ...location, latitude: -33.9 }, targetSupplierId: "a" })).rejects.toThrow();
  });
  it("rechecks locked request stock and the supplier's current radius on acceptance", async () => {
    vi.mocked(requests.acceptPurchaseRequest).mockImplementation(async (...args) => {
      const validate = args[3]!;
      await validate(row({ qty: 9 }), { id: "a", latitude: location.latitude, longitude: location.longitude, service_radius_km: 1 } as never, {} as never);
      return row({ status: "accepted", accepted_supplier_id: "a" });
    });
    vi.mocked(listStockingSupplierIds).mockResolvedValue([]);
    await expect(acceptPurchaseRequestFor({ ...company, supplierId: "a" }, "req")).rejects.toThrow();
    expect(listStockingSupplierIds).toHaveBeenCalledWith(5, 9, expect.any(Object));
  });
});
