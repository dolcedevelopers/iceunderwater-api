import { beforeEach,expect,it,vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import { assertFeatureSchemaOnConnection,deliveryColumns,ensureDeliverySchemaOnConnection,featureSchemaReady } from "../src/db/featureSchema.js";
import { ensureLiveSchemaOnConnection } from "../src/db/ensureSchema.js";
import { query } from "../src/db/pool.js";
vi.mock("../src/db/pool.js",()=>({query:vi.fn(),getPool:vi.fn()}));
function database(present:string[]=[]) {
  const columns=new Set(present),calls:string[]=[];let index=false;
  const run=vi.fn(async(sql:string,params?:unknown)=>{
    calls.push(sql);
    if(sql.includes("COUNT(*) AS n"))return [[{n:1}]]; // Existing legacy request/invoice schema.
    if(sql.includes("information_schema.COLUMNS")){const [table,column]=params as string[];return [columns.has(`${table}.${column}`)?[{COLUMN_NAME:column}]:[]];}
    if(sql.includes("information_schema.STATISTICS"))return [index?[{INDEX_NAME:"idx_iuw_delivery_deadline"}]:[]];
    const add=sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/);if(add){columns.add(`${add[1]}.${add[2]}`);return [{}];}
    if(sql.startsWith("ALTER TABLE")&&sql.includes("ADD KEY")){index=true;return [{}];}
    if(sql.startsWith("CREATE TABLE IF NOT EXISTS iuw_event_rsvps")){for(const c of ['id','event_key','wp_user_id','email','province','city','status','created_at','updated_at'])columns.add(`iuw_event_rsvps.${c}`);return [{}];}
    const probe=sql.match(/^SELECT (.+) FROM (\w+) LIMIT 0$/);if(probe){for(const c of probe[1]!.split(','))if(!columns.has(`${probe[2]}.${c}`))throw Object.assign(new Error(`Unknown column ${c}`),{code:"ER_BAD_FIELD_ERROR"});return [[]];}
    return [{}];
  });
  return {conn:{query:run} as unknown as PoolConnection,columns,calls,run};
}
beforeEach(()=>vi.resetAllMocks());
it("repairs missing delivery columns and RSVP table on the runtime connection before startup verification",async()=>{
  const db=database();const result=await ensureLiveSchemaOnConnection(db.conn);
  expect(result).toContain("iuw_deliveries.collect_by");
  for(const key of Object.keys(deliveryColumns))expect(db.columns.has(`iuw_deliveries.${key}`)).toBe(true);
  expect(db.columns.has("iuw_delivery_events.details")).toBe(true);
  expect(db.columns.has("iuw_event_rsvps.wp_user_id")).toBe(true);
  expect(db.calls.findIndex(s=>s.includes("ADD COLUMN collect_by"))).toBeLessThan(db.calls.findIndex(s=>s.startsWith("SELECT accepted_at,")));
});
it("repairs a partially applied migration without altering existing columns or data",async()=>{
  const db=database(["iuw_deliveries.accepted_at","iuw_deliveries.arrived_at","iuw_delivery_events.details"]);
  await ensureDeliverySchemaOnConnection(db.conn);
  expect(db.calls.some(s=>s.includes("ADD COLUMN accepted_at"))).toBe(false);
  expect(db.calls.some(s=>s.includes("ADD COLUMN collect_by"))).toBe(true);
  const before=db.calls.filter(s=>s.startsWith("ALTER")).length;
  expect(await ensureDeliverySchemaOnConnection(db.conn)).toEqual([]);
  expect(db.calls.filter(s=>s.startsWith("ALTER")).length).toBe(before);
});
it("does not hide DDL permission failures and start an incompatible worker",async()=>{
  const db=database();db.run.mockImplementation(async(sql:string)=>{if(sql.startsWith("ALTER"))throw Object.assign(new Error("ALTER command denied"),{code:"ER_TABLEACCESS_DENIED_ERROR"});return [[]];});
  await expect(ensureDeliverySchemaOnConnection(db.conn)).rejects.toThrow("ALTER command denied");
});
it("startup verification fails if a required field is missing",async()=>{
  const db=database();await expect(assertFeatureSchemaOnConnection(db.conn)).rejects.toMatchObject({code:"ER_BAD_FIELD_ERROR"});
});
it("readiness probes the required columns without changing schema",async()=>{
  vi.mocked(query).mockResolvedValue([]);expect(await featureSchemaReady()).toBe(true);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("collect_by"));
  expect(vi.mocked(query).mock.calls.every(([sql])=>sql.startsWith("SELECT"))).toBe(true);
  vi.mocked(query).mockRejectedValue(new Error("Unknown column collect_by"));expect(await featureSchemaReady()).toBe(false);
});
