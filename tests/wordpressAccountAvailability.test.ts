import { beforeEach, expect, it, vi } from "vitest";
import { httpJson } from "../src/clients/http.js";
import { AppError } from "../src/lib/errors.js";
import { verifyWpCredentials, registerWpCustomer, createWpUserViaBridge } from "../src/clients/wordpress.js";
vi.mock("../src/clients/http.js",()=>({httpJson:vi.fn()}));
beforeEach(()=>vi.resetAllMocks());
it.each([403,502,503])("reports upstream %s as account-service unavailability",async(status)=>{
 vi.mocked(httpJson).mockRejectedValue(new AppError(status,status===403?"ACCESS_DENIED":"UPSTREAM_ERROR","Upstream unavailable"));
 await expect(verifyWpCredentials("a@example.test","password")).rejects.toMatchObject({status:503,code:"AUTH_SERVICE_UNAVAILABLE",expose:true});
});
it("does not hide invalid passwords as service outages",async()=>{
 vi.mocked(httpJson).mockRejectedValue(new AppError(401,"ACCESS_DENIED","The login details are incorrect."));
 await expect(verifyWpCredentials("a@example.test","bad")).rejects.toMatchObject({status:401});
});
it("stops registration fallback when the host is blocked",async()=>{
 vi.mocked(httpJson).mockRejectedValue(new AppError(403,"ACCESS_DENIED","Forbidden"));
 await expect(registerWpCustomer("a@example.test","password","Person")).rejects.toMatchObject({status:503,code:"AUTH_SERVICE_UNAVAILABLE"});
 expect(httpJson).toHaveBeenCalledTimes(1);
});
it("keeps the supported registration fallback for missing legacy routes",async()=>{
 vi.mocked(httpJson).mockRejectedValueOnce(new AppError(404,"NOT_FOUND","Not found")).mockResolvedValueOnce({user:{id:12,email:"a@example.test"}});
 expect(await registerWpCustomer("a@example.test","password","Person")).toMatchObject({wpUserId:12});expect(httpJson).toHaveBeenCalledTimes(2);
});
it("reports business registration hosting failures clearly",async()=>{
 vi.mocked(httpJson).mockRejectedValue(new AppError(502,"UPSTREAM_ERROR","Unavailable"));
 await expect(createWpUserViaBridge({email:"a@example.test",password:"password",displayName:"Company",roles:["iuw_supplier"]})).rejects.toMatchObject({status:503,code:"AUTH_SERVICE_UNAVAILABLE"});
});
