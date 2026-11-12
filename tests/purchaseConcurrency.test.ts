import { beforeEach, expect, it, vi } from "vitest";
import { cancelPurchaseRequest, markCheckoutStarted, acceptPurchaseRequest, resendPurchaseRequest } from "../src/repositories/purchaseRequestRepo.js";

const connection = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ query: vi.fn(), execute: vi.fn(),
  withTransaction: (fn: (conn: unknown) => unknown) => fn(connection),
}));
beforeEach(() => vi.resetAllMocks());

it("builds payment from the locked quantity after a concurrent resend", async () => {
  const locked = { id: "req", status: "open", qty: 4, is_expired: 0 };
  connection.query.mockResolvedValue([[]])
    .mockResolvedValueOnce([[locked]])
    .mockResolvedValueOnce([[{ supplier_id: "a" }]])
    .mockResolvedValueOnce([[{ id: "a" }]]);
  const build = vi.fn((row) => `checkout?quantity=${row.qty}`);
  await acceptPurchaseRequest("req", "a", build);
  expect(build).toHaveBeenCalledWith(locked);
  expect(connection.query.mock.calls[3]?.[1]).toEqual(["a", "checkout?quantity=4", "req"]);
});

it("does not erase offers when an acceptance wins the resend race", async () => {
  connection.query.mockResolvedValueOnce([[{ id: "req", status: "accepted" }]]);
  await expect(resendPurchaseRequest({ requestId: "req", qty: 4, windowMinutes: 15,
    deliveryAt: new Date(Date.now()+86400000), targetSupplierId: null, supplierIds: ["a"] })).rejects.toThrow();
  expect(connection.query).toHaveBeenCalledTimes(1);
  expect(connection.execute).not.toHaveBeenCalled();
});

it("validates the locked destination and quantity before accepting", async () => {
  const locked = { id: "req", status: "open", qty: 8, is_expired: 0, location_address: "Changed address", location_latitude: -33, location_longitude: 18 };
  const supplier = { id: "a", service_radius_km: 5 };
  connection.query.mockResolvedValueOnce([[locked]]).mockResolvedValueOnce([[{ supplier_id: "a" }]]).mockResolvedValueOnce([[supplier]]);
  const validate = vi.fn(async () => { throw new Error("Outside service area"); });
  const checkout = vi.fn();
  await expect(acceptPurchaseRequest("req", "a", checkout, validate)).rejects.toThrow("Outside service area");
  expect(validate).toHaveBeenCalledWith(locked, supplier, connection);
  expect(checkout).not.toHaveBeenCalled();
  expect(connection.query).toHaveBeenCalledTimes(3);
});


it.each(["open", "expired", "accepted"])("cancels a locked %s request and closes its offers", async (status) => {
  connection.query.mockResolvedValue([[]]).mockResolvedValueOnce([[{ id: "req", status, customer_wp_user_id: 1, requester_supplier_id: null, checkout_url: "old-url" }]]);
  const result = await cancelPurchaseRequest("req", { customerWpUserId: 1, supplierId: null });
  expect(connection.query.mock.calls[0]![0]).toContain("FOR UPDATE");
  expect(result.status).toBe("cancelled");
  expect(result.checkout_url).toBe("");
  expect(connection.query.mock.calls[2]![0]).toContain("iuw_purchase_request_offers");
});
it.each(["checkout_started", "paid"])("does not cancel when payment wins the race (%s)", async (status) => {
  connection.query.mockResolvedValueOnce([[{ status, customer_wp_user_id: 1 }]]);
  await expect(cancelPurchaseRequest("req", { customerWpUserId: 1, supplierId: null })).rejects.toThrow();
  expect(connection.query).toHaveBeenCalledTimes(1);
});
it("cannot start checkout when cancellation wins the race", async () => {
  connection.query.mockResolvedValueOnce([[{ status: "cancelled", accepted_supplier_id: "a" }]]);
  await expect(markCheckoutStarted("req")).rejects.toThrow();
  expect(connection.query).toHaveBeenCalledTimes(1);
});
it("starts checkout under the same request lock used for cancellation", async () => {
  connection.query.mockResolvedValue([[]]).mockResolvedValueOnce([[{ status: "accepted", accepted_supplier_id: "a", checkout_url: "link" }]]);
  const result = await markCheckoutStarted("req");
  expect(connection.query.mock.calls[0]![0]).toContain("FOR UPDATE");
  expect(result.status).toBe("checkout_started");
  expect(result.checkout_url).toBe("link");
});
it.each([{ customerWpUserId: 2, supplierId: null }, { customerWpUserId: 1, supplierId: "other-company" }])("rechecks ownership under the cancellation lock %j", async (owner) => {
  connection.query.mockResolvedValueOnce([[{ status: "open", customer_wp_user_id: 1, requester_supplier_id: null }]]);
  await expect(cancelPurchaseRequest("req", owner)).rejects.toThrow();
  expect(connection.query).toHaveBeenCalledTimes(1);
});
it("treats repeated cancellation as an idempotent read", async () => {
  connection.query.mockResolvedValueOnce([[{ status: "cancelled", customer_wp_user_id: 1 }]]);
  expect((await cancelPurchaseRequest("req", { customerWpUserId: 1, supplierId: null })).status).toBe("cancelled");
  expect(connection.query).toHaveBeenCalledTimes(1);
});
