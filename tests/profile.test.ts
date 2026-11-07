import { beforeEach, expect, it, vi } from "vitest";
import { myProfileFor } from "../src/services/identityService.js";
import { query } from "../src/db/pool.js";
import type { Principal } from "../src/authz/permissions.js";
vi.mock("../src/db/pool.js", () => ({ query: vi.fn(), execute: vi.fn() }));
const buyer: Principal = { sub: 11, wpUserId: 11, role: "customer", email: "me@example.com" };
beforeEach(() => vi.resetAllMocks());
it("reads the uploaded photo for the authenticated account", async () => {
  vi.mocked(query).mockResolvedValue([{ name: "My Name", email: buyer.email, avatarUrl: "https://iceunderwater.co.za/uploads/me.jpg", password_hash: "never-return" }] as never);
  const profile = await myProfileFor(buyer);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE u.ID = :id"), { id: 11 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("iuw_avatar_url"), { id: 11 });
  expect(profile).toEqual({ name: "My Name", email: buyer.email, avatarUrl: "https://iceunderwater.co.za/uploads/me.jpg" });
});
it("rejects anonymous profile reads", async () => {
  await expect(myProfileFor(null)).rejects.toMatchObject({ status: 401 });
  expect(query).not.toHaveBeenCalled();
});
it("does not query WordPress user records for driver accounts", async () => {
  expect(await myProfileFor({ ...buyer, wpUserId: 0, role: "driver", driverId: "driver" })).toEqual({ name: buyer.email, email: buyer.email, avatarUrl: "" });
  expect(query).not.toHaveBeenCalled();
});
