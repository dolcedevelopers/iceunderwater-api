import { isSupplier, requireSignedIn, canCreatePurchaseRequests, canAccessTransaction, resolveSupplierScope, type SessionLike } from "../authz/permissions.js";
import { accessDenied } from "../lib/errors.js";
import { listTransactionsFor } from "./transactionService.js";
import { listPurchaseRequestsFor } from "./purchaseRequestService.js";

export async function purchaseHistoryFor(session: SessionLike) {
  const principal = requireSignedIn(session);
  if (!canCreatePurchaseRequests(principal)) throw accessDenied();
  const [requests, transactions] = await Promise.all([
    listPurchaseRequestsFor(principal), listTransactionsFor(principal),
  ]);
  const supplierId = isSupplier(principal) ? resolveSupplierScope(principal) : null;
  return {
    requests: requests.filter((row) => supplierId ? row.requesterSupplierId === supplierId
      : row.customerWpUserId === principal.wpUserId),
    purchases: transactions.filter((row) => supplierId ? row.transactionType === "purchase"
      : canAccessTransaction(principal, row)),
  };
}
