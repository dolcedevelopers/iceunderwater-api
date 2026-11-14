import { expect,it } from "vitest";
import { checkDeliveryAccess, deliveryTransition, type DeliveryState } from "../src/lib/deliveryFlow.js";
import type { Principal } from "../src/authz/permissions.js";
const driver:Principal={sub:0,wpUserId:0,role:"driver",driverId:"driver-a",email:"driver@example.test"};
const customer:Principal={sub:7,wpUserId:7,role:"customer",email:"buyer@example.test"};
const supplier:Principal={sub:8,wpUserId:8,role:"supplier",supplierId:"supplier-a",email:"supplier@example.test"};
const now=new Date("2026-12-05T10:00:00Z");
function row(status:string,extra:Partial<DeliveryState>={}):DeliveryState{return {status,driver_id:"driver-a",supplier_id:"supplier-a",customer_wp_user_id:7,customer_email:customer.email,...extra};}
it("only assigned driver can accept and start",()=>{expect(deliveryTransition(driver,row("assigned"),"start",now)).toBe("en-route");expect(()=>deliveryTransition({...driver,driverId:"other"},row("assigned"),"start",now)).toThrow();expect(()=>deliveryTransition(supplier,row("assigned"),"start",now)).toThrow();});
it("driver can decline only before departure",()=>{expect(deliveryTransition(driver,row("assigned"),"decline",now)).toBe("declined");expect(()=>deliveryTransition(driver,row("en-route"),"decline",now)).toThrow();});
it("requires departure before arrival",()=>{expect(deliveryTransition(driver,row("en-route"),"arrive",now)).toBe("arrived");expect(()=>deliveryTransition(driver,row("assigned"),"arrive",now)).toThrow();});
it("only the buyer can confirm physical receipt during the collection window",()=>{const r=row("arrived",{collect_by:new Date(now.getTime()+1000)});expect(deliveryTransition(customer,r,"receive",now)).toBe("delivered");expect(()=>deliveryTransition(driver,r,"receive",now)).toThrow();expect(()=>deliveryTransition(supplier,r,"receive",now)).toThrow();});
it("prevents early departure and expires exactly at the server deadline",()=>{expect(()=>deliveryTransition(driver,row("arrived",{collect_by:new Date(now.getTime()+1)}),"not-collected",now)).toThrow();expect(deliveryTransition(driver,row("arrived",{collect_by:now}),"not-collected",now)).toBe("not_delivered");expect(()=>deliveryTransition(customer,row("arrived",{collect_by:now}),"receive",now)).toThrow();});
it("never allows arbitrary status changes or an unarrived receipt",()=>{expect(()=>deliveryTransition(customer,row("en-route"),"receive",now)).toThrow();expect(()=>deliveryTransition(driver,row("delivered"),"start",now)).toThrow();});
it("customer requests redelivery only for missed orders",()=>{expect(deliveryTransition(customer,row("not_delivered"),"redeliver",now)).toBe("redelivery_requested");expect(()=>deliveryTransition(customer,row("delivered"),"redeliver",now)).toThrow();});
it("supplier can reassign a declined or requested attempt, not a completed order",()=>{expect(deliveryTransition(supplier,row("redelivery_requested"),"reassign",now)).toBe("assigned");expect(()=>deliveryTransition(supplier,row("delivered"),"reassign",now)).toThrow();expect(()=>deliveryTransition(customer,row("declined"),"reassign",now)).toThrow();});
it("allows a company buyer to receive its own purchase",()=>{expect(deliveryTransition({...supplier,wpUserId:7},row("arrived",{collect_by:new Date(now.getTime()+1000)}),"receive",now)).toBe("delivered");});
it("does not disclose delivery records to another buyer or unsigned user",()=>{expect(()=>checkDeliveryAccess({...customer,wpUserId:99},row("assigned"))).toThrow();expect(()=>checkDeliveryAccess(null,row("assigned"))).toThrow();});
