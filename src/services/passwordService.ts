import { requireSignedIn, isDriver, type SessionLike } from "../authz/permissions.js";
import { validationError, accessDenied } from "../lib/errors.js";
import { verifyWpCredentials, updateWpPassword } from "../clients/wordpress.js";
import { findDriverById, updateDriver } from "../repositories/driverRepo.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { ownerKeyFor } from "../auth/tokens.js";
import { execute, query } from "../db/pool.js";
import type { RowDataPacket } from "mysql2";
import { writeAudit } from "../repositories/auditRepo.js";

export async function changePasswordFor(session: SessionLike, input: {
  currentPassword: string; newPassword: string; passwordConfirm: string;
}, ip?: string) {
  const principal = requireSignedIn(session);
  if (!input.currentPassword || input.newPassword.length < 8 || input.newPassword.length > 128) {
    throw validationError("Use a new password between 8 and 128 characters.");
  }
  if (input.newPassword !== input.passwordConfirm) throw validationError("Passwords do not match.");
  if (input.currentPassword === input.newPassword) throw validationError("Choose a different new password.");
  if (isDriver(principal)) {
    const driver = principal.driverId ? await findDriverById(principal.driverId) : null;
    if (!driver?.active || driver.supplier_id !== principal.supplierId) throw accessDenied();
    if (!driver.password_hash || !await verifyPassword(driver.password_hash, input.currentPassword)) {
      throw validationError("Current password is incorrect.");
    }
    await updateDriver(driver.id, { password_hash: await hashPassword(input.newPassword) });
  } else {
    const accounts = await query<(RowDataPacket & { user_email: string })[]>(
      "SELECT user_email FROM wp_users WHERE ID = :userId LIMIT 1", { userId: principal.wpUserId },
    );
    if (!accounts[0]?.user_email) throw accessDenied();
    let verified;
    try { verified = await verifyWpCredentials(accounts[0].user_email, input.currentPassword); }
    catch (error) {
      if ((error as { status?: number }).status === 401 || (error as { status?: number }).status === 403) {
        throw validationError("Current password is incorrect.");
      }
      throw error;
    }
    if (verified.wpUserId !== principal.wpUserId) throw accessDenied();
    await updateWpPassword(principal.wpUserId, input.newPassword);
  }
  await execute(`UPDATE iuw_refresh_tokens SET revoked_at = UTC_TIMESTAMP(3)
    WHERE owner_key = :ownerKey AND revoked_at IS NULL`, { ownerKey: ownerKeyFor(principal) });
  await writeAudit({ session: principal, action: "account.password.change", targetType: "account",
    targetId: ownerKeyFor(principal), ip });
  return { ok: true, signInAgain: true };
}
