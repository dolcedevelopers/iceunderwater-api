import { beforeEach, expect, it, vi } from "vitest";
import { assignDelivery } from "../src/services/driverService.js";
import { findDriverById } from "../src/repositories/driverRepo.js";
import { findTransactionByOrderId } from "../src/repositories/transactionRepo.js";
import { insertDelivery } from "../src/repositories/deliveryRepo.js";

vi.mock("../src/repositories/driverRepo.js", () => ({ findDriverById: vi.fn(), updateDriver: vi.fn(),
  insertDriver: vi.fn(), insertDriverPing: vi.fn(), latestDriverPing: vi.fn(), listDrivers: vi.fn(), softDeleteDriver: vi.fn() }));
vi.mock("../src/repositories/transactionRepo.js", () => ({ findTransactionByOrderId: vi.fn() }));
vi.mock("../src/repositories/deliveryRepo.js", () => ({ insertDelivery: vi.fn(), findActiveDeliveryForDriverCustomer: vi.fn(),
  findDeliveryById: vi.fn(), listDeliveries: vi.fn(), updateDeliveryStatus: vi.fn() }));
vi.mock("../src/repositories/auditRepo.js", () => ({ writeAudit: vi.fn() }));

const supplier = { sub: 1, wpUserId: 1, role: "supplier" as const, supplierId: "a", email: "a@example.com" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findDriverById).mockResolvedValue({ id: "driver", supplier_id: "a" } as never);
  vi.mocked(findTransactionByOrderId).mockResolvedValue({ status: "paid", supplier_id: "a",
    customer_wp_user_id: 9, customer_email: "actual@example.com" } as never);
  vi.mocked(insertDelivery).mockResolvedValue({ id: "delivery" } as never);
});
it.each(["pending", "failed", "refunded"])("blocks delivery before confirmed payment (%s)", async (status) => {
  vi.mocked(findTransactionByOrderId).mockResolvedValue({ status, supplier_id: "a" } as never);
  await expect(assignDelivery(supplier, { driverId: "driver", orderId: 3 })).rejects.toThrow();
  expect(insertDelivery).not.toHaveBeenCalled();
});
it("blocks a supplier from delivering another supplier's order", async () => {
  vi.mocked(findTransactionByOrderId).mockResolvedValue({ status: "paid", supplier_id: "b" } as never);
  await expect(assignDelivery(supplier, { driverId: "driver", orderId: 3 })).rejects.toThrow();
});
it("uses the paid order's customer identity instead of caller-supplied details", async () => {
  await assignDelivery(supplier, { driverId: "driver", orderId: 3, customerWpUserId: 99, customerEmail: "wrong@example.com" });
  expect(insertDelivery).toHaveBeenCalledWith(expect.objectContaining({
    customer_wp_user_id: 9, customer_email: "actual@example.com", supplier_id: "a",
  }));
});
