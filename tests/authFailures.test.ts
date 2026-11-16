import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { httpJson } from "../src/clients/http.js";
beforeEach(()=>vi.stubGlobal("fetch",vi.fn()));
afterEach(()=>vi.unstubAllGlobals());
it("reports the hosting firewall as a service failure without retrying or blaming credentials",async()=>{
 vi.mocked(fetch).mockResolvedValue({ok:false,status:403,json:async()=>({message:"Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted"})} as Response);
 await expect(httpJson("https://example.test/verify",{retries:2})).rejects.toMatchObject({status:503,code:"AUTH_SERVICE_UNAVAILABLE",expose:true,message:"Sign-in and registration are temporarily unavailable. Please try again later."});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it("retains incorrect credentials as an authentication failure",async()=>{
 vi.mocked(fetch).mockResolvedValue({ok:false,status:401,json:async()=>({message:"The login details are incorrect."})} as Response);
 await expect(httpJson("https://example.test/verify")).rejects.toMatchObject({status:401,message:"The login details are incorrect."});
 expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not turn ordinary authorization failures into hosting failures",async()=>{
 vi.mocked(fetch).mockResolvedValue({ok:false,status:403,json:async()=>({message:"Forbidden"})} as Response);
 await expect(httpJson("https://example.test/verify")).rejects.toMatchObject({status:403,code:"ACCESS_DENIED"});
});
