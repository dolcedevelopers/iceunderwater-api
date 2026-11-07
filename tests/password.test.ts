import { beforeEach, expect, it, vi } from "vitest";
import { changePasswordFor } from "../src/services/passwordService.js";
import { verifyWpCredentials, updateWpPassword } from "../src/clients/wordpress.js";
import { findDriverById, updateDriver } from "../src/repositories/driverRepo.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { execute, query } from "../src/db/pool.js";
import { writeAudit } from "../src/repositories/auditRepo.js";
import type { Principal } from "../src/authz/permissions.js";

vi.mock("../src/clients/wordpress.js", () => ({ verifyWpCredentials: vi.fn(), updateWpPassword: vi.fn() }));
vi.mock("../src/repositories/driverRepo.js", () => ({ findDriverById: vi.fn(), updateDriver: vi.fn() }));
vi.mock("../src/auth/password.js", () => ({ hashPassword: vi.fn(), verifyPassword: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({ execute: vi.fn(), query: vi.fn() }));
vi.mock("../src/repositories/auditRepo.js", () => ({ writeAudit: vi.fn() }));
const customer: Principal = { sub: 11, wpUserId: 11, role: "customer", email: "old@example.com" };
const input = { currentPassword: "old-secret", newPassword: "new-secret-123", passwordConfirm: "new-secret-123" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(query).mockResolvedValue([{ user_email: "current@example.com" }] as never);
  vi.mocked(verifyWpCredentials).mockResolvedValue({ wpUserId: 11, email: "current@example.com", displayName: "Buyer", roles: ["customer"] });
  vi.mocked(findDriverById).mockResolvedValue({ id: "driver", supplier_id: "a", active: 1, password_hash: "old-hash" } as never);
  vi.mocked(verifyPassword).mockResolvedValue(true);
  vi.mocked(hashPassword).mockResolvedValue("new-hash");
});
it.each(["customer", "supplier", "admin"] as const)("changes only the authenticated %s's password after checking current credentials", async (role) => {
  expect(await changePasswordFor({ ...customer, role, supplierId: "a" }, input)).toEqual({ ok: true, signInAgain: true });
  expect(verifyWpCredentials).toHaveBeenCalledWith("current@example.com", input.currentPassword);
  expect(updateWpPassword).toHaveBeenCalledWith(11, input.newPassword);
  expect(execute).toHaveBeenCalledWith(expect.stringContaining("revoked_at"), { ownerKey: "wp:11" });
  expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "account.password.change" }));
  expect(JSON.stringify(vi.mocked(writeAudit).mock.calls)).not.toContain(input.newPassword);
});
it("rejects anonymous password changes", async () => {
  await expect(changePasswordFor(null, input)).rejects.toMatchObject({ status: 401 });
  expect(updateWpPassword).not.toHaveBeenCalled();
});
it("rejects incorrect current passwords without changing or revoking credentials", async () => {
  vi.mocked(verifyWpCredentials).mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
  await expect(changePasswordFor(customer, input)).rejects.toMatchObject({ status: 400 });
  expect(updateWpPassword).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it("cannot change a different WordPress account even with that account's password", async () => {
  vi.mocked(verifyWpCredentials).mockResolvedValue({ wpUserId: 99 } as never);
  await expect(changePasswordFor(customer, input)).rejects.toMatchObject({ status: 403 });
  expect(updateWpPassword).not.toHaveBeenCalled();
});
it.each([
  { ...input, newPassword: "short", passwordConfirm: "short" },
  { ...input, passwordConfirm: "different" },
  { ...input, newPassword: input.currentPassword, passwordConfirm: input.currentPassword },
])("validates the new password before touching stored credentials", async (value) => {
  await expect(changePasswordFor(customer, value)).rejects.toMatchObject({ status: 400 });
  expect(verifyWpCredentials).not.toHaveBeenCalled();
});
it("does not report success or revoke sessions when the WordPress update fails", async () => {
  vi.mocked(updateWpPassword).mockRejectedValue(new Error("Upstream unavailable"));
  await expect(changePasswordFor(customer, input)).rejects.toThrow("Upstream unavailable");
  expect(execute).not.toHaveBeenCalled();
});
it("hashes a driver's new password and never sends it to WordPress", async () => {
  await changePasswordFor({ ...customer, role: "driver", wpUserId: 0, driverId: "driver", supplierId: "a" }, input);
  expect(updateDriver).toHaveBeenCalledWith("driver", { password_hash: "new-hash" });
  expect(updateWpPassword).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledWith(expect.any(String), { ownerKey: "driver:driver" });
});
it("rejects a driver linked to a different company", async () => {
  await expect(changePasswordFor({ ...customer, role: "driver", driverId: "driver", supplierId: "b" }, input)).rejects.toMatchObject({ status: 403 });
  expect(updateDriver).not.toHaveBeenCalled();
});
it("checks the driver's existing password before writing the new hash", async () => {
  vi.mocked(verifyPassword).mockResolvedValue(false);
  await expect(changePasswordFor({ ...customer, role: "driver", driverId: "driver", supplierId: "a" }, input)).rejects.toMatchObject({ status: 400 });
  expect(updateDriver).not.toHaveBeenCalled();
});
