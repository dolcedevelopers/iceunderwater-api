import { beforeEach, expect, it, vi } from "vitest";
import { cancelRsvp, csvCell, myRsvp, rsvpAttendees, rsvpBreakdown, rsvpExport, rsvpSummary, saveRsvp } from "../src/services/eventRsvpService.js";
import { execute, query } from "../src/db/pool.js";
import type { Principal } from "../src/authz/permissions.js";
vi.mock("../src/db/pool.js",()=>({query:vi.fn(),execute:vi.fn()}));
const buyer:Principal={sub:7,wpUserId:7,email:"person@example.test",role:"customer"};
const admin:Principal={...buyer,role:"admin",adminRole:"owner"};
beforeEach(()=>{vi.resetAllMocks();vi.mocked(query).mockResolvedValue([]);});
it("counts cities as shares of confirmed attendance, including cities outside the four examples",()=>{
  const result=rsvpBreakdown([{province:"Gauteng",city:"Pretoria",count:"40"},{province:"KwaZulu-Natal",city:"Durban",count:20},{province:"Western Cape",city:"Cape Town",count:20},{province:"Gauteng",city:"Johannesburg",count:10},{province:"Free State",city:"Bloemfontein",count:10}]);
  expect(result.total).toBe(100);expect(result.cities.map(r=>r.percentage)).toEqual([40,20,20,10,10]);
});
it("handles no RSVPs without NaN and rounds fractional percentages",()=>{expect(rsvpBreakdown([])).toEqual({total:0,cities:[]});expect(rsvpBreakdown([{province:"Gauteng",city:"Pretoria",count:1},{province:"Gauteng",city:"Johannesburg",count:2}]).cities[0]!.percentage).toBe(33.3);});
it("requires a signed-in, real attendee account",async()=>{await expect(myRsvp(null)).rejects.toMatchObject({status:401});await expect(myRsvp({...buyer,role:"driver",wpUserId:0})).rejects.toMatchObject({status:403});expect(query).not.toHaveBeenCalled();});
it("upserts one RSVP per event/account and does not accept a caller identity",async()=>{await saveRsvp(buyer,{province:"Gauteng",city:"Pretoria"});expect(execute).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE"),expect.objectContaining({user:7,event:"warrior-kings",email:buyer.email,city:"Pretoria"}));expect(query).toHaveBeenCalledWith(expect.stringContaining("wp_user_id = :user"),{user:7,event:"warrior-kings"});});
it("rejects a city from another province before saving",async()=>{await expect(saveRsvp(buyer,{province:"Gauteng",city:"Durban"})).rejects.toMatchObject({status:400});expect(execute).not.toHaveBeenCalled();});
it("cancels only the caller's RSVP and excludes cancellations from admin statistics",async()=>{await cancelRsvp(buyer);expect(execute).toHaveBeenCalledWith(expect.stringContaining("wp_user_id=:user"),{user:7,event:"warrior-kings"});await rsvpSummary(admin);expect(query).toHaveBeenLastCalledWith(expect.stringContaining("status='confirmed'"),expect.anything());});
it.each([rsvpSummary,rsvpAttendees,rsvpExport])("keeps the admin report private",async fn=>{await expect(fn(buyer)).rejects.toMatchObject({status:403});expect(query).not.toHaveBeenCalled();});
it("escapes CSV formulas and quotes",()=>{expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');expect(csvCell("normal@example.test")).toBe('"normal@example.test"');});
