import { makeId, normalizeEmail } from "../lib/ids.js";
import { createWpUserViaBridge, verifyWpCredentials } from "../clients/wordpress.js";
import { findAdminByWpUserId, insertAdmin, listAdmins } from "../repositories/adminRepo.js";
import { AppError } from "../lib/errors.js";

/**
 * One-shot first owner seed for empty installs.
 * Set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD on the host, restart once,
 * then remove those env vars.
 */
export async function seedFirstOwnerIfConfigured(log?: {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}): Promise<{ seeded: boolean; email?: string; id?: string }> {
  const emailRaw = process.env.SEED_ADMIN_EMAIL?.trim() || "";
  const password = process.env.SEED_ADMIN_PASSWORD || "";
  const name = (process.env.SEED_ADMIN_NAME || "Owner").trim();
  if (!emailRaw || !password) return { seeded: false };

  const existing = await listAdmins();
  if (existing.length > 0) {
    log?.info({ count: existing.length }, "SEED_ADMIN_* ignored — admins already exist");
    return { seeded: false };
  }

  const email = normalizeEmail(emailRaw);
  if (!email || password.length < 8) {
    throw new Error("SEED_ADMIN_EMAIL/PASSWORD invalid (password min 8 chars).");
  }

  let wpUser;
  try {
    wpUser = await createWpUserViaBridge({
      email,
      password,
      displayName: name,
      roles: ["iuw_admin"],
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 0;
    if (status !== 409) throw error;
    // Account already in WordPress — verify password and link as owner.
    wpUser = await verifyWpCredentials(email, password);
    if (!wpUser.roles.map((r) => r.toLowerCase()).includes("iuw_admin") &&
        !wpUser.roles.map((r) => r.toLowerCase()).includes("administrator")) {
      throw new Error(
        `WordPress user ${email} exists but lacks iuw_admin/administrator. Add the role in WP, then restart.`,
      );
    }
  }

  const linked = await findAdminByWpUserId(wpUser.wpUserId);
  if (linked) return { seeded: false, email, id: linked.id };

  const row = await insertAdmin({
    id: makeId("adm"),
    wp_user_id: wpUser.wpUserId,
    name,
    email,
    role: "owner",
  });

  log?.warn(
    { email, id: row.id, wpUserId: wpUser.wpUserId },
    "Seeded first owner admin — remove SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD from the host env now",
  );

  return { seeded: true, email, id: row.id };
}
