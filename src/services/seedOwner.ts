import { makeId, normalizeEmail } from "../lib/ids.js";
import { createWpUserViaBridge, verifyWpCredentials } from "../clients/wordpress.js";
import { findAdminByWpUserId, insertAdmin, listAdmins } from "../repositories/adminRepo.js";
import { AppError, conflict } from "../lib/errors.js";

export async function createFirstOwner(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ id: string; email: string; role: string; wpUserId: number }> {
  const existing = await listAdmins();
  if (existing.length > 0) throw conflict("An owner already exists.");

  const email = normalizeEmail(input.email);
  const name = (input.name || "Owner").trim();
  if (!email || !input.password || input.password.length < 8) {
    throw new AppError(400, "VALIDATION_ERROR", "Valid email and password (min 8) are required.");
  }

  let wpUser;
  try {
    wpUser = await createWpUserViaBridge({
      email,
      password: input.password,
      displayName: name,
      roles: ["iuw_admin"],
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 0;
    if (status !== 409) throw error;
    wpUser = await verifyWpCredentials(email, input.password);
    const roles = wpUser.roles.map((r) => r.toLowerCase());
    if (!roles.includes("iuw_admin") && !roles.includes("administrator")) {
      throw new AppError(
        409,
        "CONFLICT",
        `WordPress user ${email} exists but lacks iuw_admin. Add the role in WP, then retry.`,
      );
    }
  }

  const linked = await findAdminByWpUserId(wpUser.wpUserId);
  if (linked) {
    return { id: linked.id, email: linked.email, role: linked.role, wpUserId: linked.wp_user_id };
  }

  const row = await insertAdmin({
    id: makeId("adm"),
    wp_user_id: wpUser.wpUserId,
    name,
    email,
    role: "owner",
  });

  return { id: row.id, email: row.email, role: row.role, wpUserId: row.wp_user_id };
}

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

  const result = await createFirstOwner({ email: emailRaw, password, name });
  log?.warn(
    { email: result.email, id: result.id, wpUserId: result.wpUserId },
    "Seeded first owner admin — remove SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD from the host env now",
  );
  return { seeded: true, email: result.email, id: result.id };
}
