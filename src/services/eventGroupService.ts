import type { Principal, SessionLike } from "../authz/permissions.js";
import {
  canAcceptEventGroupJoin,
  canDeleteEventGroup,
  canEditEventGroup,
  EVENT_GROUP_MAX_MEMBERS,
  isAdmin,
  requireEventGroupUser,
} from "../authz/permissions.js";
import { accessDenied, conflict, notFound, validationError } from "../lib/errors.js";
import { makeId, normalizeEmail } from "../lib/ids.js";
import { writeAudit } from "../repositories/auditRepo.js";
import {
  acceptJoinRequest,
  countActiveMembers,
  deleteMember,
  findEventGroupById,
  findMembership,
  findMembershipForEvent,
  insertEventGroup,
  insertMember,
  listEventGroups,
  listMembersForGroups,
  softDeleteEventGroup,
  updateEventGroup,
  type EventGroupMemberRow,
  type EventGroupRow,
} from "../repositories/eventGroupRepo.js";
import { mapEventGroup, mapEventGroupMember, type EventGroupDto } from "../serializers/dto.js";

const EVENT_KEY_RE = /^[a-z0-9-]{3,80}$/;

export function normalizeEventKey(value?: string | null): string {
  const key = String(value || "military-weekend-experience")
    .trim()
    .toLowerCase();
  if (!EVENT_KEY_RE.test(key)) throw validationError("That event is not valid.");
  return key;
}

function displayNameOf(session: Principal): string {
  return session.email.split("@")[0] || session.email;
}

function toAccess(group: EventGroupRow) {
  return {
    createdByWpUserId: Number(group.created_by_wp_user_id),
    membersCanAccept: Boolean(group.members_can_accept),
  };
}

function toMemberAccess(membership: EventGroupMemberRow | null) {
  if (!membership) return null;
  return {
    wpUserId: Number(membership.wp_user_id),
    role: membership.role,
    status: membership.status,
  };
}

function youShape(session: SessionLike, group: EventGroupRow, membership: EventGroupMemberRow | null) {
  const access = toAccess(group);
  const memberAccess = toMemberAccess(membership);
  return {
    inGroup: membership?.status === "active",
    isOwner: membership?.role === "owner" && membership.status === "active",
    canEdit: canEditEventGroup(session, access),
    canDelete: canDeleteEventGroup(session, access),
    canAccept: canAcceptEventGroupJoin(session, access, memberAccess),
    membershipStatus: membership?.status ?? null,
  };
}

function toDto(
  session: SessionLike,
  group: EventGroupRow,
  memberRows: EventGroupMemberRow[],
): EventGroupDto {
  const membership =
    session && isFinite(session.wpUserId)
      ? memberRows.find((row) => Number(row.wp_user_id) === Number(session.wpUserId)) || null
      : null;
  const you = youShape(session, group, membership || null);
  const active = memberRows.filter((row) => row.status === "active").map(mapEventGroupMember);
  const pending = you.canAccept || membership?.status === "pending"
    ? memberRows.filter((row) => row.status === "pending").map(mapEventGroupMember)
    : [];
  return mapEventGroup(group, active, pending, you);
}

async function loadGroupDto(session: SessionLike, group: EventGroupRow): Promise<EventGroupDto> {
  const members = await listMembersForGroups([group.id]);
  return toDto(session, group, members);
}

export async function listEventGroupsFor(session: SessionLike, eventKeyRaw?: string): Promise<EventGroupDto[]> {
  const eventKey = normalizeEventKey(eventKeyRaw);
  const groups = await listEventGroups(eventKey);
  const members = await listMembersForGroups(groups.map((group) => group.id));
  const byGroup = new Map<string, EventGroupMemberRow[]>();
  for (const member of members) {
    const list = byGroup.get(member.group_id) || [];
    list.push(member);
    byGroup.set(member.group_id, list);
  }
  return groups.map((group) => toDto(session, group, byGroup.get(group.id) || []));
}

export async function getEventGroupFor(session: SessionLike, groupId: string): Promise<EventGroupDto> {
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  return loadGroupDto(session, group);
}

export async function createEventGroupFor(
  session: SessionLike,
  data: { eventKey?: string; name: string; membersCanAccept?: boolean },
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const eventKey = normalizeEventKey(data.eventKey);
  const name = String(data.name || "").trim();
  if (name.length < 2) throw validationError("Give the group a name.");
  if (name.length > 120) throw validationError("Group name is too long.");

  const existing = await findMembershipForEvent(eventKey, principal.wpUserId);
  if (existing && !isAdmin(principal)) {
    throw conflict("You already have a group or a join request for this event.");
  }

  const id = makeId("grp");
  const group = await insertEventGroup({
    id,
    event_key: eventKey,
    name,
    created_by_wp_user_id: principal.wpUserId,
    members_can_accept: Boolean(data.membersCanAccept),
  });

  if (!isAdmin(principal)) {
    await insertMember({
      group_id: id,
      event_key: eventKey,
      wp_user_id: principal.wpUserId,
      display_name: displayNameOf(principal),
      email: normalizeEmail(principal.email),
      role: "owner",
      status: "active",
    });
  }

  const dto = await loadGroupDto(principal, group);
  await writeAudit({ session: principal, action: "event-group.create", targetType: "event-group", targetId: id, ip, after: dto });
  return dto;
}

export async function updateEventGroupFor(
  session: SessionLike,
  groupId: string,
  changes: { name?: string; membersCanAccept?: boolean },
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  if (!canEditEventGroup(principal, toAccess(group))) {
    throw accessDenied("Only the group creator or an administrator can edit this group.");
  }

  const patch: { name?: string; members_can_accept?: boolean } = {};
  if (typeof changes.name === "string") {
    const name = changes.name.trim();
    if (name.length < 2) throw validationError("Give the group a name.");
    patch.name = name;
  }
  if (typeof changes.membersCanAccept === "boolean") patch.members_can_accept = changes.membersCanAccept;

  const updated = await updateEventGroup(groupId, patch);
  if (!updated) throw notFound("That group is not available.");
  const dto = await loadGroupDto(principal, updated);
  await writeAudit({ session: principal, action: "event-group.update", targetType: "event-group", targetId: groupId, ip, after: dto });
  return dto;
}

export async function deleteEventGroupFor(session: SessionLike, groupId: string, ip?: string): Promise<{ ok: true }> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  if (!canDeleteEventGroup(principal, toAccess(group))) {
    throw accessDenied("Only the group creator or an administrator can delete this group.");
  }
  await softDeleteEventGroup(groupId);
  await writeAudit({ session: principal, action: "event-group.delete", targetType: "event-group", targetId: groupId, ip });
  return { ok: true };
}

export async function requestJoinEventGroupFor(session: SessionLike, groupId: string, ip?: string): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  if (isAdmin(principal)) {
    throw accessDenied("Administrators manage groups rather than joining them.");
  }

  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");

  const active = await countActiveMembers(group.id);
  if (active >= EVENT_GROUP_MAX_MEMBERS) throw conflict("This group is full (6 people).");

  await insertMember({
    group_id: group.id,
    event_key: group.event_key,
    wp_user_id: principal.wpUserId,
    display_name: displayNameOf(principal),
    email: normalizeEmail(principal.email),
    role: "member",
    status: "pending",
  });

  const dto = await loadGroupDto(principal, group);
  await writeAudit({
    session: principal,
    action: "event-group.join-request",
    targetType: "event-group",
    targetId: groupId,
    ip,
    after: { wpUserId: principal.wpUserId },
  });
  return dto;
}

export async function leaveEventGroupFor(session: SessionLike, groupId: string, ip?: string): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  const membership = await findMembership(groupId, principal.wpUserId);
  if (!membership) throw notFound("You are not in this group.");
  if (membership.role === "owner" && membership.status === "active") {
    throw conflict("The group creator cannot leave. Delete the group instead.");
  }
  await deleteMember(groupId, principal.wpUserId);
  const dto = await loadGroupDto(principal, group);
  await writeAudit({ session: principal, action: "event-group.leave", targetType: "event-group", targetId: groupId, ip });
  return dto;
}

export async function acceptEventGroupJoinFor(
  session: SessionLike,
  groupId: string,
  wpUserId: number,
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  const membership = await findMembership(groupId, principal.wpUserId);
  if (!canAcceptEventGroupJoin(principal, toAccess(group), toMemberAccess(membership))) {
    throw accessDenied("You cannot accept join requests for this group.");
  }
  await acceptJoinRequest(groupId, wpUserId);
  const dto = await loadGroupDto(principal, group);
  await writeAudit({
    session: principal,
    action: "event-group.accept",
    targetType: "event-group",
    targetId: groupId,
    ip,
    after: { wpUserId },
  });
  return dto;
}

export async function rejectEventGroupJoinFor(
  session: SessionLike,
  groupId: string,
  wpUserId: number,
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  const membership = await findMembership(groupId, principal.wpUserId);
  const target = await findMembership(groupId, wpUserId);
  if (!target || target.status !== "pending") throw notFound("That join request is not available.");
  if (!canAcceptEventGroupJoin(principal, toAccess(group), toMemberAccess(membership)) && Number(target.wp_user_id) !== principal.wpUserId) {
    throw accessDenied("You cannot decline that join request.");
  }
  await deleteMember(groupId, wpUserId);
  const dto = await loadGroupDto(principal, group);
  await writeAudit({
    session: principal,
    action: "event-group.reject",
    targetType: "event-group",
    targetId: groupId,
    ip,
    after: { wpUserId },
  });
  return dto;
}

export async function removeEventGroupMemberFor(
  session: SessionLike,
  groupId: string,
  wpUserId: number,
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  if (!canEditEventGroup(principal, toAccess(group))) {
    throw accessDenied("Only the group creator or an administrator can remove members.");
  }
  const target = await findMembership(groupId, wpUserId);
  if (!target) throw notFound("That member is not in this group.");
  if (target.role === "owner") throw conflict("The group creator cannot be removed. Delete the group instead.");
  await deleteMember(groupId, wpUserId);
  const dto = await loadGroupDto(principal, group);
  await writeAudit({
    session: principal,
    action: "event-group.remove-member",
    targetType: "event-group",
    targetId: groupId,
    ip,
    after: { wpUserId },
  });
  return dto;
}
