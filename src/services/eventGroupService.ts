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
  deleteMemberById,
  findEventGroupById,
  findMemberById,
  findMembership,
  findMembershipForEvent,
  insertEventGroup,
  insertMember,
  listEventGroups,
  listGroupsForWpUser,
  listMembersForGroups,
  softDeleteEventGroup,
  updateEventGroup,
  type EventGroupMemberRow,
  type EventGroupRow,
} from "../repositories/eventGroupRepo.js";
import { mapEventGroup, mapEventGroupMember, type EventGroupDto } from "../serializers/dto.js";
import { isHostedImageUrl, publicHttpsUrl } from "../lib/mediaUrl.js";

const EVENT_KEY_RE = /^[a-z0-9-]{3,80}$/;
const DEFAULT_COMPETITION = "ICE UNDERWATER Warrior Kings";
const DEFAULT_EVENT_KEY = "warrior-kings";

export function normalizeEventKey(value?: string | null): string {
  const key = String(value || DEFAULT_EVENT_KEY)
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
    wpUserId: membership.wp_user_id != null ? Number(membership.wp_user_id) : 0,
    role: membership.role,
    status: membership.status,
  };
}

function youShape(session: SessionLike, group: EventGroupRow, membership: EventGroupMemberRow | null) {
  const access = toAccess(group);
  const memberAccess = toMemberAccess(membership);
  const canEdit = canEditEventGroup(session, access);
  return {
    inGroup: membership?.status === "active",
    isOwner: membership?.role === "owner" && membership.status === "active",
    canEdit,
    canDelete: canDeleteEventGroup(session, access),
    canAccept: canAcceptEventGroupJoin(session, access, memberAccess),
    canAddMembers: canEdit,
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
  data: {
    eventKey?: string;
    name: string;
    membersCanAccept?: boolean;
    stage?: string;
    competitionName?: string;
    groupPhotoUrl?: string;
  },
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

  const photo = String(data.groupPhotoUrl || "").trim();
  if (photo && !isHostedImageUrl(photo)) throw validationError("Group photo URL is not valid.");

  const id = makeId("grp");
  const group = await insertEventGroup({
    id,
    event_key: eventKey,
    name,
    created_by_wp_user_id: principal.wpUserId,
    members_can_accept: Boolean(data.membersCanAccept),
    stage: data.stage || "group_stage",
    competition_name: data.competitionName || DEFAULT_COMPETITION,
    group_photo_url: photo ? publicHttpsUrl(photo) : "",
  });

  if (!isAdmin(principal)) {
    const parts = String(displayNameOf(principal)).split(/\s+/);
    await insertMember({
      group_id: id,
      event_key: eventKey,
      wp_user_id: principal.wpUserId,
      display_name: displayNameOf(principal),
      email: normalizeEmail(principal.email),
      first_name: parts[0] || "",
      surname: parts.slice(1).join(" "),
      role: "owner",
      status: "active",
      is_guest: false,
    });
  }

  const dto = await loadGroupDto(principal, group);
  await writeAudit({ session: principal, action: "event-group.create", targetType: "event-group", targetId: id, ip, after: dto });
  return dto;
}

export async function updateEventGroupFor(
  session: SessionLike,
  groupId: string,
  changes: {
    name?: string;
    membersCanAccept?: boolean;
    stage?: string;
    competitionName?: string;
    groupPhotoUrl?: string;
  },
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  if (!canEditEventGroup(principal, toAccess(group))) {
    throw accessDenied("Only the group creator or an administrator can edit this group.");
  }

  const patch: {
    name?: string;
    members_can_accept?: boolean;
    stage?: string;
    competition_name?: string;
    group_photo_url?: string;
  } = {};
  if (typeof changes.name === "string") {
    const name = changes.name.trim();
    if (name.length < 2) throw validationError("Give the group a name.");
    patch.name = name;
  }
  if (typeof changes.membersCanAccept === "boolean") patch.members_can_accept = changes.membersCanAccept;
  if (typeof changes.stage === "string" && changes.stage.trim()) patch.stage = changes.stage.trim();
  if (typeof changes.competitionName === "string" && changes.competitionName.trim()) {
    patch.competition_name = changes.competitionName.trim();
  }
  if (typeof changes.groupPhotoUrl === "string") {
    const photo = changes.groupPhotoUrl.trim();
    if (photo && !isHostedImageUrl(photo)) throw validationError("Group photo URL is not valid.");
    patch.group_photo_url = photo ? publicHttpsUrl(photo) : "";
  }

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

/** Owner adds a competition teammate by name / cell / email (guest roster). */
export async function addEventGroupMemberFor(
  session: SessionLike,
  groupId: string,
  data: { firstName: string; surname: string; phone: string; email: string; photoUrl?: string },
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  if (!canEditEventGroup(principal, toAccess(group))) {
    throw accessDenied("Only the group creator or an administrator can add members.");
  }

  const firstName = String(data.firstName || "").trim();
  const surname = String(data.surname || "").trim();
  const phone = String(data.phone || "").trim();
  const email = normalizeEmail(data.email);
  if (!firstName || !surname) throw validationError("Enter name and surname.");
  if (!phone) throw validationError("Enter a cell number.");
  if (!email) throw validationError("Enter an email address.");

  const active = await countActiveMembers(group.id);
  if (active >= EVENT_GROUP_MAX_MEMBERS) throw conflict("This group is full (6 people).");

  const photo = String(data.photoUrl || "").trim();
  if (photo && !isHostedImageUrl(photo)) throw validationError("Photo URL is not valid.");

  await insertMember({
    group_id: group.id,
    event_key: group.event_key,
    wp_user_id: null,
    display_name: `${firstName} ${surname}`.trim(),
    email,
    first_name: firstName,
    surname,
    phone,
    photo_url: photo ? publicHttpsUrl(photo) : "",
    is_guest: true,
    role: "member",
    status: "active",
  });

  const dto = await loadGroupDto(principal, group);
  await writeAudit({
    session: principal,
    action: "event-group.add-member",
    targetType: "event-group",
    targetId: groupId,
    ip,
    after: { email, firstName, surname },
  });
  return dto;
}

export async function removeEventGroupMemberByIdFor(
  session: SessionLike,
  groupId: string,
  memberId: number,
  ip?: string,
): Promise<EventGroupDto> {
  const principal = requireEventGroupUser(session);
  const group = await findEventGroupById(groupId);
  if (!group) throw notFound("That group is not available.");
  if (!canEditEventGroup(principal, toAccess(group))) {
    throw accessDenied("Only the group creator or an administrator can remove members.");
  }
  const target = await findMemberById(memberId);
  if (!target || target.group_id !== groupId) throw notFound("That member is not in this group.");
  if (target.role === "owner") throw conflict("The group creator cannot be removed. Delete the group instead.");
  await deleteMemberById(groupId, memberId);
  const dto = await loadGroupDto(principal, group);
  await writeAudit({
    session: principal,
    action: "event-group.remove-member",
    targetType: "event-group",
    targetId: groupId,
    ip,
    after: { memberId },
  });
  return dto;
}

export async function competitionProfileFor(session: SessionLike) {
  const principal = requireEventGroupUser(session);
  const groups = await listGroupsForWpUser(principal.wpUserId);
  const members = await listMembersForGroups(groups.map((g) => g.id));
  const byGroup = new Map<string, EventGroupMemberRow[]>();
  for (const member of members) {
    const list = byGroup.get(member.group_id) || [];
    list.push(member);
    byGroup.set(member.group_id, list);
  }
  return {
    competitionName: DEFAULT_COMPETITION,
    groups: groups.map((group) => {
      const dto = toDto(principal, group, byGroup.get(group.id) || []);
      return {
        id: dto.id,
        name: dto.name,
        stage: dto.stage,
        competitionName: dto.competitionName,
        memberCount: dto.memberCount,
        maxMembers: dto.maxMembers,
        you: dto.you,
      };
    }),
  };
}
