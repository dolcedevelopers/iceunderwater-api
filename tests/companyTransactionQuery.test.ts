import { beforeEach, expect, it, vi } from "vitest";
import { query } from "../src/db/pool.js";
import { listCompanyTransactions } from "../src/repositories/transactionRepo.js";
vi.mock("../src/db/pool.js", () => ({ query: vi.fn(), execute: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("binds the buyer and seller scope in both transaction and product-line queries", async () => {
  vi.mocked(query).mockResolvedValueOnce([{ id: "sale", items: "2", total_cents: "2500" }] as never)
    .mockResolvedValueOnce([{ transaction_id: "sale", wc_product_id: 1, name: "Own product", quantity: 2, line_total_cents: 2500 }] as never);
  const scope = { supplierId: "a", wpUserId: 11, id: "sale", reference: "R1" };
  const result = await listCompanyTransactions(scope);
  for (const [sql, params] of vi.mocked(query).mock.calls) {
    expect(params).toEqual(scope);
    expect(sql).toContain("t.customer_wp_user_id = :wpUserId");
    expect(sql).toContain("supplier_id = :supplierId");
    expect(sql).toContain("t.id = :id");
    expect(sql).toContain("t.reference = :reference");
  }
  expect(result[0]?.total_cents).toBe(2500);
  expect(result[0]?.line_items).toEqual([{ productId: 1, name: "Own product", quantity: 2, totalCents: 2500 }]);
});
it("returns no lines when no company transaction is authorized", async () => {
  vi.mocked(query).mockResolvedValueOnce([]);
  expect(await listCompanyTransactions({ supplierId: "a", wpUserId: 11 })).toEqual([]);
  expect(query).toHaveBeenCalledTimes(1);
});
