import type { Principal } from "../authz/permissions.js";
import { isBusiness } from "../authz/permissions.js";
import { accessDenied } from "../lib/errors.js";
import { findSupplierById } from "../repositories/supplierRepo.js";

/** Database classification is authoritative even for previously issued tokens. */
export async function currentBusinessPrincipal(principal: Principal): Promise<Principal> {
  if (!isBusiness(principal)) return principal;
  const business=principal.supplierId ? await findSupplierById(principal.supplierId) : null;
  if (!business || Number(business.wp_user_id)!==principal.wpUserId) throw accessDenied("This business account is not available.");
  return {...principal,role:business.business_type || "company",businessStatus:business.status};
}
