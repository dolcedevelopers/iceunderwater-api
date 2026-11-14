import type { RowDataPacket } from "mysql2";
import { requireAdmin, requireRole, ROLES, type SessionLike } from "../authz/permissions.js";
import { query, execute } from "../db/pool.js";
import { validationError } from "../lib/errors.js";
import { makeId } from "../lib/ids.js";
import { selectedCity } from "../lib/serviceArea.js";

export const RSVP_EVENT_KEY = "warrior-kings";
type RsvpRow = RowDataPacket & { id: string; event_key: string; wp_user_id: number; email: string; province: string; city: string; status: string; updated_at: Date };
function attendee(session: SessionLike) {
  const person = requireRole(session, ROLES.CUSTOMER, ROLES.SUPPLIER, ROLES.ADMIN);
  if (!Number.isSafeInteger(person.wpUserId) || person.wpUserId <= 0) throw validationError("Sign in with your customer account to RSVP.");
  return person;
}
function dto(row: RsvpRow) { return { id: row.id, eventKey: row.event_key, province: row.province, city: row.city, status: row.status, updatedAt: new Date(row.updated_at).toISOString() }; }
export async function myRsvp(session: SessionLike) {
  const person = attendee(session);
  const rows = await query<RsvpRow[]>("SELECT * FROM iuw_event_rsvps WHERE event_key = :event AND wp_user_id = :user", { event: RSVP_EVENT_KEY, user: person.wpUserId });
  return rows[0] ? dto(rows[0]) : null;
}
export async function saveRsvp(session: SessionLike, place: { province: string; city: string }) {
  const person = attendee(session); const location = selectedCity(place.province, place.city);
  await execute(`INSERT INTO iuw_event_rsvps (id,event_key,wp_user_id,email,province,city,status)
    VALUES (:id,:event,:user,:email,:province,:city,'confirmed')
    ON DUPLICATE KEY UPDATE email=VALUES(email), province=VALUES(province), city=VALUES(city), status='confirmed', updated_at=UTC_TIMESTAMP(3)`,
    { id: makeId("rsvp"), event: RSVP_EVENT_KEY, user: person.wpUserId, email: person.email, ...location });
  return myRsvp(person);
}
export async function cancelRsvp(session: SessionLike) {
  const person = attendee(session);
  await execute("UPDATE iuw_event_rsvps SET status='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE event_key=:event AND wp_user_id=:user", { event: RSVP_EVENT_KEY, user: person.wpUserId });
  return myRsvp(person);
}
export function rsvpBreakdown(rows: { province: string; city: string; count: number | string }[]) {
  const total = rows.reduce((n, row) => n + Number(row.count), 0);
  return { total, cities: rows.map(row => ({ province: row.province, city: row.city, count: Number(row.count), percentage: total ? Math.round(Number(row.count) / total * 1000) / 10 : 0 })) };
}
export async function rsvpSummary(session: SessionLike) {
  requireAdmin(session);
  const rows = await query<(RowDataPacket & { province: string; city: string; count: number })[]>(`SELECT province,city,COUNT(*) AS count FROM iuw_event_rsvps WHERE event_key=:event AND status='confirmed' GROUP BY province,city ORDER BY count DESC,city ASC`, { event: RSVP_EVENT_KEY });
  return { eventKey: RSVP_EVENT_KEY, ...rsvpBreakdown(rows), updatedAt: new Date().toISOString() };
}
export async function rsvpAttendees(session: SessionLike, options: {page?:number;search?:string}={}) {
  requireAdmin(session);
  const page=options.page||1;const needle=(options.search||"").trim();const filter=needle?" AND (email LIKE :search OR city LIKE :search OR province LIKE :search)":"";
  const params={event:RSVP_EVENT_KEY,...(needle?{search:`%${needle}%`}:{})};
  const total=await query<(RowDataPacket & {count:number})[]>(`SELECT COUNT(*) AS count FROM iuw_event_rsvps WHERE event_key=:event AND status='confirmed'${filter}`,params);
  const rows=await query<RsvpRow[]>(`SELECT * FROM iuw_event_rsvps WHERE event_key=:event AND status='confirmed'${filter} ORDER BY city,email LIMIT 50 OFFSET ${(page-1)*50}`,params);
  return {items:rows.map(row=>({...dto(row),email:row.email})),total:Number(total[0]?.count||0),page,pageSize:50};
}

export function csvCell(value: string) { return '"' + (/^(?:\s*[=+@\-]|[\t\r])/.test(value) ? "'" : "") + value.replace(/"/g, '""') + '"'; }
export async function rsvpExport(session: SessionLike) {
  requireAdmin(session);
  const records=await query<RsvpRow[]>("SELECT * FROM iuw_event_rsvps WHERE event_key=:event AND status='confirmed' ORDER BY city,email",{event:RSVP_EVENT_KEY});
  const rows=records.map(row=>({...dto(row),email:row.email}));
  return { filename: "warrior-kings-rsvps.csv", content: "Email,Province,City,Status,Updated\r\n" + rows.map(r => [r.email,r.province,r.city,r.status,r.updatedAt].map(csvCell).join(",")).join("\r\n") };
}
