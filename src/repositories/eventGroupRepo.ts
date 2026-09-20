import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { execute, query, withTransaction } from "../db/pool.js";
import { conflict, notFound } from "../lib/errors.js";
import { EVENT_GROUP_MAX_MEMBERS } from "../authz/permissions.js";

export type EventGroupRow = RowDataPacket & {
  id: string;
  event_key: string;
  name: string;
  created_by_wp_user_id: number;
  members_can_accept: number;
  stage: string;
  competition_name: string;
  group_photo_url: string;
  created_at: Date;
  deleted_at: Date | null;
};

export type EventGroupMemberRow = RowDataPacket & {
  id: number;
  group_id: string;
  event_key: string;
  wp_user_id: number | null;
  display_name: string;
  email: string;
  first_name: string;
  surname: string;
  phone: string;
  photo_url: string;
  is_guest: number;
  role: "owner" | "member";
  status: "pending" | "active";
  created_at: Date;
};

export async function listEventGroups(eventKey: string): Promise<EventGroupRow[]> {
  return query<EventGroupRow[]>(
    `SELECT * FROM iuw_event_groups
     WHERE event_key = :eventKey AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    { eventKey },
  );
}

export async function listGroupsForWpUser(wpUserId: number): Promise<EventGroupRow[]> {
  return query<EventGroupRow[]>(
    `SELECT g.* FROM iuw_event_groups g
     INNER JOIN iuw_event_group_members m ON m.group_id = g.id
     WHERE m.wp_user_id = :wpUserId AND m.status = 'active' AND g.deleted_at IS NULL
     ORDER BY g.created_at DESC`,
    { wpUserId },
  );
}

export async function findEventGroupById(id: string): Promise<EventGroupRow | null> {
  const rows = await query<EventGroupRow[]>(
    `SELECT * FROM iuw_event_groups WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

export async function listMembersForGroups(groupIds: string[]): Promise<EventGroupMemberRow[]> {
  if (!groupIds.length) return [];
  const placeholders = groupIds.map((_, i) => `:gid${i}`).join(", ");
  const params: Record<string, unknown> = {};
  groupIds.forEach((id, i) => {
    params[`gid${i}`] = id;
  });
  return query<EventGroupMemberRow[]>(
    `SELECT * FROM iuw_event_group_members WHERE group_id IN (${placeholders}) ORDER BY created_at ASC`,
    params,
  );
}

export async function findMembershipForEvent(
  eventKey: string,
  wpUserId: number,
): Promise<EventGroupMemberRow | null> {
  const rows = await query<EventGroupMemberRow[]>(
    `SELECT * FROM iuw_event_group_members
     WHERE event_key = :eventKey AND wp_user_id = :wpUserId LIMIT 1`,
    { eventKey, wpUserId },
  );
  return rows[0] || null;
}

export async function findMembership(groupId: string, wpUserId: number): Promise<EventGroupMemberRow | null> {
  const rows = await query<EventGroupMemberRow[]>(
    `SELECT * FROM iuw_event_group_members WHERE group_id = :groupId AND wp_user_id = :wpUserId LIMIT 1`,
    { groupId, wpUserId },
  );
  return rows[0] || null;
}

export async function findMemberById(memberId: number): Promise<EventGroupMemberRow | null> {
  const rows = await query<EventGroupMemberRow[]>(
    `SELECT * FROM iuw_event_group_members WHERE id = :memberId LIMIT 1`,
    { memberId },
  );
  return rows[0] || null;
}

export async function countActiveMembers(groupId: string): Promise<number> {
  const rows = await query<(RowDataPacket & { c: number })[]>(
    `SELECT COUNT(*) AS c FROM iuw_event_group_members WHERE group_id = :groupId AND status = 'active'`,
    { groupId },
  );
  return Number(rows[0]?.c || 0);
}

export async function insertEventGroup(row: {
  id: string;
  event_key: string;
  name: string;
  created_by_wp_user_id: number;
  members_can_accept: boolean;
  stage?: string;
  competition_name?: string;
  group_photo_url?: string;
}): Promise<EventGroupRow> {
  await execute(
    `INSERT INTO iuw_event_groups
      (id, event_key, name, created_by_wp_user_id, members_can_accept, stage, competition_name, group_photo_url)
     VALUES
      (:id, :event_key, :name, :created_by_wp_user_id, :members_can_accept, :stage, :competition_name, :group_photo_url)`,
    {
      ...row,
      members_can_accept: row.members_can_accept ? 1 : 0,
      stage: row.stage || "group_stage",
      competition_name: row.competition_name || "ICE UNDERWATER Warrior Kings",
      group_photo_url: row.group_photo_url || "",
    },
  );
  const created = await findEventGroupById(row.id);
  if (!created) throw new Error("event group insert failed");
  return created;
}

export async function insertMember(row: {
  group_id: string;
  event_key: string;
  wp_user_id: number | null;
  display_name: string;
  email: string;
  first_name?: string;
  surname?: string;
  phone?: string;
  photo_url?: string;
  is_guest?: boolean;
  role: "owner" | "member";
  status: "pending" | "active";
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO iuw_event_group_members
        (group_id, event_key, wp_user_id, display_name, email, first_name, surname, phone, photo_url, is_guest, role, status)
       VALUES
        (:group_id, :event_key, :wp_user_id, :display_name, :email, :first_name, :surname, :phone, :photo_url, :is_guest, :role, :status)`,
      {
        ...row,
        first_name: row.first_name || "",
        surname: row.surname || "",
        phone: row.phone || "",
        photo_url: row.photo_url || "",
        is_guest: row.is_guest || row.wp_user_id == null ? 1 : 0,
      },
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ER_DUP_ENTRY") {
      throw conflict("You already have a group or a join request for this event.");
    }
    throw error;
  }
}

export async function updateEventGroup(
  id: string,
  changes: Partial<{
    name: string;
    members_can_accept: boolean;
    stage: string;
    competition_name: string;
    group_photo_url: string;
  }>,
): Promise<EventGroupRow | null> {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  if (changes.name !== undefined) {
    fields.push("name = :name");
    params.name = changes.name;
  }
  if (changes.members_can_accept !== undefined) {
    fields.push("members_can_accept = :members_can_accept");
    params.members_can_accept = changes.members_can_accept ? 1 : 0;
  }
  if (changes.stage !== undefined) {
    fields.push("stage = :stage");
    params.stage = changes.stage;
  }
  if (changes.competition_name !== undefined) {
    fields.push("competition_name = :competition_name");
    params.competition_name = changes.competition_name;
  }
  if (changes.group_photo_url !== undefined) {
    fields.push("group_photo_url = :group_photo_url");
    params.group_photo_url = changes.group_photo_url;
  }
  if (!fields.length) return findEventGroupById(id);
  await execute(`UPDATE iuw_event_groups SET ${fields.join(", ")} WHERE id = :id AND deleted_at IS NULL`, params);
  return findEventGroupById(id);
}

export async function softDeleteEventGroup(id: string): Promise<void> {
  await withTransaction(async (conn) => {
    await conn.query(`DELETE FROM iuw_event_group_members WHERE group_id = ?`, [id]);
    await conn.query(`UPDATE iuw_event_groups SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL`, [
      id,
    ]);
  });
}

export async function deleteMember(groupId: string, wpUserId: number): Promise<void> {
  await execute(`DELETE FROM iuw_event_group_members WHERE group_id = :groupId AND wp_user_id = :wpUserId`, {
    groupId,
    wpUserId,
  });
}

export async function deleteMemberById(groupId: string, memberId: number): Promise<void> {
  await execute(`DELETE FROM iuw_event_group_members WHERE group_id = :groupId AND id = :memberId`, {
    groupId,
    memberId,
  });
}

export async function acceptJoinRequest(groupId: string, wpUserId: number): Promise<void> {
  await withTransaction(async (conn) => {
    const [groups] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM iuw_event_groups WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      [groupId],
    );
    if (!groups[0]) throw notFound("That group is not available.");

    const [countRows] = await conn.query<(RowDataPacket & { c: number })[]>(
      `SELECT COUNT(*) AS c FROM iuw_event_group_members WHERE group_id = ? AND status = 'active'`,
      [groupId],
    );
    if (Number(countRows[0]?.c || 0) >= EVENT_GROUP_MAX_MEMBERS) {
      throw conflict("This group is full (6 people).");
    }

    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE iuw_event_group_members
       SET status = 'active', role = 'member'
       WHERE group_id = ? AND wp_user_id = ? AND status = 'pending'`,
      [groupId, wpUserId],
    );
    if (!result.affectedRows) {
      throw notFound("That join request is not available.");
    }
  });
}
