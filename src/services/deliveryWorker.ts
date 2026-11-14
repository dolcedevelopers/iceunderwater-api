import { sweepMissedDeliveries } from "./deliveryWorkflowService.js";
/** Server timestamps remain authoritative even when the buyer closes the app. */
export function startDeliveryWorker(onError:(error:unknown)=>void) {
  let running=false;
  const run=async()=>{if(running)return;running=true;try{await sweepMissedDeliveries();}catch(error){onError(error);}finally{running=false;}};
  void run();const timer=setInterval(()=>void run(),15000);timer.unref();return()=>clearInterval(timer);
}
