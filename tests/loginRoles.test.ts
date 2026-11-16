import { beforeEach, expect, it, vi } from "vitest";
import { login } from "../src/services/identityService.js";
import { verifyWpCredentials } from "../src/clients/wordpress.js";
import { findAdminByWpUserId } from "../src/repositories/adminRepo.js";
import { findSupplierByWpUserId } from "../src/repositories/supplierRepo.js";
import { signAccessToken, issueRefreshToken } from "../src/auth/tokens.js";
vi.mock("../src/clients/wordpress.js",()=>({verifyWpCredentials:vi.fn(),registerWpCustomer:vi.fn(),resolveSiteToken:vi.fn(),createWpUserViaBridge:vi.fn()}));
vi.mock("../src/repositories/adminRepo.js",()=>({findAdminByWpUserId:vi.fn()}));
vi.mock("../src/repositories/supplierRepo.js",()=>({findSupplierByWpUserId:vi.fn(),insertSupplier:vi.fn()}));
vi.mock("../src/auth/tokens.js",()=>({signAccessToken:vi.fn(async()=>"access"),issueRefreshToken:vi.fn(async()=>"refresh")}));
const input={accountType:"admin" as const,email:"admin@example.test",password:"test-password",client:"mobile" as const};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(verifyWpCredentials).mockResolvedValue({wpUserId:1,email:input.email,displayName:"Admin",roles:["administrator"]});vi.mocked(findAdminByWpUserId).mockResolvedValue({id:"admin",wp_user_id:1,status:"active",role:"owner"} as never);vi.mocked(findSupplierByWpUserId).mockResolvedValue(null);});
it("allows an active administrator through the Administrator card",async()=>{
 expect((await login(input)).principal).toMatchObject({role:"admin",adminRole:"owner",wpUserId:1});
 expect(signAccessToken).toHaveBeenCalledTimes(1);expect(issueRefreshToken).toHaveBeenCalledTimes(1);
});
it("gives a useful card hint after valid credentials without issuing the wrong role",async()=>{
 await expect(login({...input,accountType:"customer"})).rejects.toMatchObject({status:403,code:"ACCOUNT_TYPE_MISMATCH",message:"Choose Administrator to sign in to this account."});
 expect(signAccessToken).not.toHaveBeenCalled();
});
it("keeps inactive admin accounts blocked",async()=>{
 vi.mocked(findAdminByWpUserId).mockResolvedValue({status:"suspended"} as never);
 await expect(login(input)).rejects.toMatchObject({status:403,message:"This admin account is not active."});
 expect(signAccessToken).not.toHaveBeenCalled();
});
it.each(["company","supplier"] as const)("allows the matching %s sign-in",async(role)=>{
 vi.mocked(verifyWpCredentials).mockResolvedValue({wpUserId:2,email:input.email,displayName:"Business",roles:["iuw_supplier"]});
 vi.mocked(findSupplierByWpUserId).mockResolvedValue({id:"business",wp_user_id:2,status:"active",business_type:role} as never);
 expect((await login({...input,accountType:role})).principal).toMatchObject({role,supplierId:"business"});
});
