import type { RowDataPacket } from "mysql2";
import { execute, query } from "../db/pool.js";
import { makeId } from "../lib/ids.js";

export type NotificationRow = RowDataPacket & {
  id: string;
  recipient_kind: "wp" | "supplier" | "driver";
  recipient_id: string;
  title: string;
  body: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  read_at: Date | null;
  created_at: Date;
};

export async function insertNotification(input: {
  recipientKind: NotificationRow["recipient_kind"];
  recipientId: string;
  title: string;
  body?: string;
  kind?: string;
  refType?: string;
  refId?: string;
}): Promise<NotificationRow> {
  const id = makeId("ntf");
  await execute(
    `INSERT INTO iuw_notifications
      (id, recipient_kind, recipient_id, title, body, kind, ref_type, ref_id)
     VALUES
      (:id, :recipientKind, :recipientId, :title, :body, :kind, :refType, :refId)`,
    {
      id,
      recipientKind: input.recipientKind,
      recipientId: String(input.recipientId),
      title: input.title,
      body: input.body || "",
      kind: input.kind || "info",
      refType: input.refType || "",
      refId: input.refId || "",
    },
  );
  const rows = await query<NotificationRow[]>(
    `SELECT * FROM iuw_notifications WHERE id = :id LIMIT 1`,
    { id },
  );
  return rows[0]!;
}

export async function listNotificationsFor(
  recipientKind: NotificationRow["recipient_kind"],
  recipientId: string,
  limit = 50,
): Promise<NotificationRow[]> {
  return query<NotificationRow[]>(
    `SELECT * FROM iuw_notifications
     WHERE recipient_kind = :recipientKind AND recipient_id = :recipientId
     ORDER BY created_at DESC
     LIMIT ${Math.min(100, Math.max(1, limit))}`,
    { recipientKind, recipientId: String(recipientId) },
  );
}

export async function markNotificationRead(
  id: string,
  recipientKind: NotificationRow["recipient_kind"],
  recipientId: string,
): Promise<boolean> {
  const result = await execute(
    `UPDATE iuw_notifications
     SET read_at = COALESCE(read_at, UTC_TIMESTAMP(3))
     WHERE id = :id AND recipient_kind = :recipientKind AND recipient_id = :recipientId`,
    { id, recipientKind, recipientId: String(recipientId) },
  );
  return Boolean(result.affectedRows);
}
