import { startDeliveryWorker } from "./services/deliveryWorker.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { ensureLiveSchema } from "./db/ensureSchema.js";
import { seedFirstOwnerIfConfigured } from "./services/seedOwner.js";

async function main() {
  const repaired = await ensureLiveSchema();
  const app = await buildApp();
  if (repaired.length) {
    app.log.warn({ repaired }, "Repaired and verified schema on the runtime database before starting workers");
  }
  await seedFirstOwnerIfConfigured(app.log);
  const stopWorker=startDeliveryWorker(error=>app.log.error({err:error},"Delivery worker failed"));
  app.addHook("onClose",async()=>stopWorker());
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`ICE UNDERWATER API listening on ${config.HOST}:${config.PORT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
