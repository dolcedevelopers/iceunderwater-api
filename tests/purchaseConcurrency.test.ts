import { beforeEach, expect, it, vi } from "vitest";
import { acceptPurchaseRequest, resendPurchaseRequest } from "../src/repositories/purchaseRequestRepo.js";

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
