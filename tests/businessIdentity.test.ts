import { beforeEach, expect, it, vi } from "vitest";
import { currentBusinessPrincipal } from "../src/auth/businessIdentity.js";
import { findSupplierById } from "../src/repositories/supplierRepo.js";
import type { Principal } from "../src/authz/permissions.js";
vi.mock("../src/repositories/supplierRepo.js",()=>({findSupplierById:vi.fn()}));
const person: Principal={sub:7,wpUserId:7,role:"supplier",email:"a@example.com",supplierId:"a"};
beforeEach(()=>vi.resetAllMocks());
it("treats existing business accounts as companies, regardless of old token role",async()=>{
  vi.mocked(findSupplierById).mockResolvedValue({id:"a",wp_user_id:7,status:"active"} as never);
  expect(await currentBusinessPrincipal(person)).toMatchObject({role:"company",businessStatus:"active"});
});
it("applies admin reclassification to previously issued company tokens",async()=>{
  vi.mocked(findSupplierById).mockResolvedValue({id:"a",wp_user_id:7,status:"active",business_type:"supplier"} as never);
  expect(await currentBusinessPrincipal({...person,role:"company"})).toMatchObject({role:"supplier"});
});
it("rejects deleted or foreign business links",async()=>{
  vi.mocked(findSupplierById).mockResolvedValue(null);
  await expect(currentBusinessPrincipal(person)).rejects.toThrow();
  vi.mocked(findSupplierById).mockResolvedValue({id:"a",wp_user_id:99,business_type:"supplier"} as never);
  await expect(currentBusinessPrincipal(person)).rejects.toThrow();
});
it("does not query wholesale identity for customers",async()=>{
  const customer={...person,role:"customer" as const,supplierId:undefined};
  expect(await currentBusinessPrincipal(customer)).toBe(customer);
  expect(findSupplierById).not.toHaveBeenCalled();
});
