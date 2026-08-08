import { execute } from "../db/pool.js";
import type { SessionLike } from "../authz/permissions.js";
import { roleOf } from "../authz/permissions.js";

export async function writeAudit(input: {
  session: SessionLike;
  action: string;
  targetType: string;
  targetId: string;
  ip?: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await execute(
    `INSERT INTO iuw_audit_log
      (actor_wp_user_id, actor_role, action, target_type, target_id, ip, before_json, after_json)
     VALUES
      (:actorId, :actorRole, :action, :targetType, :targetId, :ip, CAST(:beforeJson AS JSON), CAST(:afterJson AS JSON))`,
    {
      actorId: input.session?.wpUserId ?? null,
      actorRole: roleOf(input.session),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      ip: input.ip || "",
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    },
  );
}
