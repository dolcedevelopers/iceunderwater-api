import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { isSupplier, requireSignedIn } from "../authz/permissions.js";
import { accessDenied, notFound } from "../lib/errors.js";
import {
  listNotificationsFor,
  markNotificationRead,
  type NotificationRow,
} from "../repositories/notificationRepo.js";

function mapNotification(row: NotificationRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    refType: row.ref_type,
    refId: row.ref_id,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : "",
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function recipientOf(session: ReturnType<typeof requireSignedIn>): {
  kind: NotificationRow["recipient_kind"];
  id: string;
} {
  if (isSupplier(session) && session.supplierId) {
    return { kind: "supplier", id: session.supplierId };
  }
  if (session.wpUserId) {
    return { kind: "wp", id: String(session.wpUserId) };
  }
  if (session.driverId) {
    return { kind: "driver", id: String(session.driverId) };
  }
  throw accessDenied();
}

const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/notifications", async (request) => {
    const session = requireAuth(request);
    const recipient = recipientOf(session);
    const rows = await listNotificationsFor(recipient.kind, recipient.id);
    return {
      unread: rows.filter((row) => !row.read_at).length,
      items: rows.map(mapNotification),
    };
  });

  app.post<{ Params: { id: string } }>("/notifications/:id/read", async (request) => {
    const session = requireAuth(request);
    const recipient = recipientOf(session);
    const ok = await markNotificationRead(request.params.id, recipient.kind, recipient.id);
    if (!ok) throw notFound("That notification is not available.");
    return { ok: true };
  });
};

export default notificationRoutes;
