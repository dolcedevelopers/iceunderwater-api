import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import { myRsvp, saveRsvp, cancelRsvp, rsvpSummary, rsvpAttendees, rsvpExport } from "../services/eventRsvpService.js";
const place = z.object({ province: z.string().min(1).max(80), city: z.string().min(1).max(120) }).strict();
const eventRsvps: FastifyPluginAsync = async app => {
  app.get("/events/warrior-kings/rsvp", req => myRsvp(requireAuth(req)));
  app.put("/events/warrior-kings/rsvp", req => saveRsvp(requireAuth(req), place.parse(req.body)));
  app.delete("/events/warrior-kings/rsvp", req => cancelRsvp(requireAuth(req)));
  app.get("/admin/events/warrior-kings/rsvps", req => rsvpSummary(requireAuth(req)));
  app.get("/admin/events/warrior-kings/rsvps/attendees", req => rsvpAttendees(requireAuth(req),z.object({page:z.coerce.number().int().min(1).max(100000).optional(),search:z.string().max(100).optional()}).parse(req.query)));
  app.get("/admin/events/warrior-kings/rsvps/export", req => rsvpExport(requireAuth(req)));
};
export default eventRsvps;
