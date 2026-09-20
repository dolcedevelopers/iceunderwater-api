import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth.js";
import {
  acceptEventGroupJoinFor,
  addEventGroupMemberFor,
  competitionProfileFor,
  createEventGroupFor,
  deleteEventGroupFor,
  getEventGroupFor,
  leaveEventGroupFor,
  listEventGroupsFor,
  rejectEventGroupJoinFor,
  removeEventGroupMemberByIdFor,
  removeEventGroupMemberFor,
  requestJoinEventGroupFor,
  updateEventGroupFor,
} from "../services/eventGroupService.js";

const createSchema = z
  .object({
    eventKey: z.string().min(3).max(80).optional(),
    name: z.string().min(2).max(120),
    membersCanAccept: z.boolean().optional(),
    stage: z.string().optional(),
    competitionName: z.string().optional(),
    groupPhotoUrl: z.string().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    membersCanAccept: z.boolean().optional(),
    stage: z.string().optional(),
    competitionName: z.string().optional(),
    groupPhotoUrl: z.string().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name != null ||
      body.membersCanAccept != null ||
      body.stage != null ||
      body.competitionName != null ||
      body.groupPhotoUrl != null,
    { message: "Provide a field to update." },
  );

const addMemberSchema = z
  .object({
    firstName: z.string().min(1),
    surname: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    photoUrl: z.string().optional(),
  })
  .strict();

const eventGroupsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/event-groups", async (request) => {
    const query = z.object({ eventKey: z.string().optional() }).parse(request.query);
    return listEventGroupsFor(request.principal, query.eventKey);
  });

  app.get("/me/competition-profile", async (request) => competitionProfileFor(requireAuth(request)));

  app.get<{ Params: { id: string } }>("/event-groups/:id", async (request) =>
    getEventGroupFor(request.principal, request.params.id),
  );

  app.post("/event-groups", async (request) => {
    const body = createSchema.parse(request.body);
    return createEventGroupFor(requireAuth(request), body, request.ip);
  });

  app.patch<{ Params: { id: string } }>("/event-groups/:id", async (request) => {
    const body = patchSchema.parse(request.body);
    return updateEventGroupFor(requireAuth(request), request.params.id, body, request.ip);
  });

  app.delete<{ Params: { id: string } }>("/event-groups/:id", async (request) =>
    deleteEventGroupFor(requireAuth(request), request.params.id, request.ip),
  );

  app.post<{ Params: { id: string } }>("/event-groups/:id/join", async (request) =>
    requestJoinEventGroupFor(requireAuth(request), request.params.id, request.ip),
  );

  app.post<{ Params: { id: string } }>("/event-groups/:id/leave", async (request) =>
    leaveEventGroupFor(requireAuth(request), request.params.id, request.ip),
  );

  app.post<{ Params: { id: string } }>("/event-groups/:id/members", async (request) => {
    const body = addMemberSchema.parse(request.body);
    return addEventGroupMemberFor(requireAuth(request), request.params.id, body, request.ip);
  });

  app.delete<{ Params: { id: string; memberId: string } }>(
    "/event-groups/:id/members/by-id/:memberId",
    async (request) =>
      removeEventGroupMemberByIdFor(
        requireAuth(request),
        request.params.id,
        Number(request.params.memberId),
        request.ip,
      ),
  );

  app.post<{ Params: { id: string; wpUserId: string } }>(
    "/event-groups/:id/members/:wpUserId/accept",
    async (request) =>
      acceptEventGroupJoinFor(requireAuth(request), request.params.id, Number(request.params.wpUserId), request.ip),
  );

  app.post<{ Params: { id: string; wpUserId: string } }>(
    "/event-groups/:id/members/:wpUserId/reject",
    async (request) =>
      rejectEventGroupJoinFor(requireAuth(request), request.params.id, Number(request.params.wpUserId), request.ip),
  );

  app.delete<{ Params: { id: string; wpUserId: string } }>(
    "/event-groups/:id/members/:wpUserId",
    async (request) =>
      removeEventGroupMemberFor(requireAuth(request), request.params.id, Number(request.params.wpUserId), request.ip),
  );
};

export default eventGroupsRoutes;
