import { publicHttpsUrl } from "../lib/mediaUrl.js";
import { centsToRands } from "../lib/money.js";
import { EVENT_GROUP_MAX_MEMBERS } from "../authz/permissions.js";

export type SupplierDto = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  city: string;
  province: string;
  /** Legal identity a valid invoice has to print. Empty until the company fills it in. */
  vatNumber: string;
  registrationNumber: string;
  address: string;
  logo: string;
  status: "active" | "pending" | "suspended";
  /** Admin-set markup % applied to supplier cost → shop selling price. */
  markupPercent: number;
  createdAt: string;
};

export type ProductDto = {
  id: string;
  supplierId: string;
  name: string;
  category: string;
  /** Supplier cost / loaded price (what the company sets). */
  costPrice: number;
  /** Customer-facing selling price after markup (Woo regular_price). */
  price: number;
  markupPercent: number;
  stock: number;
  unit: string;
  description: string;
  image: string;
  active: boolean;
};

export type DriverDto = {
  id: string;
  supplierId: string;
  name: string;
  phone: string;
  email: string;
  vehicle: string;
  registration: string;
  licence: string;
  status: "available" | "on-delivery" | "off-duty";
  active: boolean;
};

export type CustomerDto = {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  orders: number;
  spend: number;
  status: "active" | "blocked";
  createdAt: string;
};

export type AdminDto = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "manager" | "support";
  status: string;
  createdAt: string;
};

export type TransactionDto = {
  transactionType?: "sale" | "purchase";
  lineItems?: { productId: number | null; name: string; quantity: number; total: number }[];
  id: string;
  reference: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  supplierId: string;
  supplierName: string;
  /**
   * Supplier legal identity copied onto the invoice. Only ever returned with a
   * transaction the caller is already allowed to read.
   */
  supplierVatNumber: string;
  supplierRegistrationNumber: string;
  supplierAddress: string;
  items: number;
  total: number;
  status: "paid" | "pending" | "refunded" | "failed";
  method: string;
  createdAt: string;
  receiptSentAt: string;
};

export type SupplierInvoiceIdentity = {
  vatNumber: string;
  registrationNumber: string;
  address: string;
};

export function toIso(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return new Date(value).toISOString();
  return value.toISOString();
}

export function mapSupplier(row: {
  id: string;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  city: string;
  province?: string;
  vat_number?: string | null;
  registration_number?: string | null;
  address?: string | null;
  logo_url: string;
  status: SupplierDto["status"];
  markup_percent?: number | string | null;
  created_at: Date | string;
}): SupplierDto {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    province: row.province || "",
    vatNumber: row.vat_number || "",
    registrationNumber: row.registration_number || "",
    address: row.address || "",
    logo: publicHttpsUrl(row.logo_url),
    status: row.status,
    markupPercent: Number(row.markup_percent) || 0,
    createdAt: toIso(row.created_at),
  };
}

export function mapDriver(row: {
  id: string;
  supplier_id: string;
  name: string;
  phone: string;
  email: string;
  vehicle: string;
  registration: string;
  licence: string;
  status: DriverDto["status"];
  active: number | boolean;
}): DriverDto {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    vehicle: row.vehicle,
    registration: row.registration,
    licence: row.licence,
    status: row.status,
    active: Boolean(row.active),
  };
}

export function mapAdmin(row: {
  id: string;
  name: string;
  email: string;
  role: AdminDto["role"];
  status: string;
  created_at: Date | string;
}): AdminDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: toIso(row.created_at),
  };
}

export type EventGroupMemberDto = {
  id: number;
  wpUserId: number | null;
  name: string;
  firstName: string;
  surname: string;
  email: string;
  phone: string;
  photo: string;
  isGuest: boolean;
  role: "owner" | "member";
  status: "pending" | "active";
};

export type EventGroupDto = {
  id: string;
  eventKey: string;
  name: string;
  createdByWpUserId: number;
  membersCanAccept: boolean;
  stage: string;
  competitionName: string;
  groupPhoto: string;
  memberCount: number;
  maxMembers: number;
  spotsLeft: number;
  members: EventGroupMemberDto[];
  pending: EventGroupMemberDto[];
  you: {
    inGroup: boolean;
    isOwner: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canAccept: boolean;
    canAddMembers: boolean;
    membershipStatus: "pending" | "active" | null;
  };
  createdAt: string;
};

export function mapTransaction(row: {
  transaction_type?: "sale" | "purchase";
  line_items?: { productId: number | null; name: string; quantity: number; totalCents: number }[];
  id: string;
  reference: string;
  customer_wp_user_id: number | null;
  customer_name: string;
  customer_email: string;
  supplier_id: string;
  supplier_name: string;
  items: number;
  total_cents: number;
  status: TransactionDto["status"];
  method: string;
  created_at: Date | string;
  receipt_sent_at: Date | string | null;
}, supplier?: SupplierInvoiceIdentity | null): TransactionDto {
  return {
    ...(row.transaction_type ? { transactionType: row.transaction_type } : {}),
    ...(row.line_items ? { lineItems: row.line_items.map(({ totalCents, ...line }) => ({ ...line, total: centsToRands(totalCents) })) } : {}),
    id: row.id,
    reference: row.reference,
    customerId: row.customer_wp_user_id != null ? String(row.customer_wp_user_id) : "",
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierVatNumber: supplier?.vatNumber || "",
    supplierRegistrationNumber: supplier?.registrationNumber || "",
    supplierAddress: supplier?.address || "",
    items: row.items,
    total: centsToRands(row.total_cents),
    status: row.status,
    method: row.method,
    createdAt: toIso(row.created_at),
    receiptSentAt: row.receipt_sent_at ? toIso(row.receipt_sent_at) : "",
  };
}

export function mapEventGroupMember(row: {
  id?: number;
  wp_user_id: number | null;
  display_name: string;
  first_name?: string;
  surname?: string;
  email: string;
  phone?: string;
  photo_url?: string;
  is_guest?: number | boolean;
  role: "owner" | "member";
  status: "pending" | "active";
}): EventGroupMemberDto {
  const firstName = row.first_name || "";
  const surname = row.surname || "";
  const composed = [firstName, surname].filter(Boolean).join(" ").trim();
  return {
    id: Number(row.id) || 0,
    wpUserId: row.wp_user_id != null ? Number(row.wp_user_id) : null,
    name: composed || row.display_name || row.email,
    firstName,
    surname,
    email: row.email,
    phone: row.phone || "",
    photo: publicHttpsUrl(row.photo_url || ""),
    isGuest: Boolean(row.is_guest) || row.wp_user_id == null,
    role: row.role,
    status: row.status,
  };
}

export function mapEventGroup(
  row: {
    id: string;
    event_key: string;
    name: string;
    created_by_wp_user_id: number;
    members_can_accept: number | boolean;
    stage?: string;
    competition_name?: string;
    group_photo_url?: string;
    created_at: Date | string;
  },
  members: EventGroupMemberDto[],
  pending: EventGroupMemberDto[],
  you: EventGroupDto["you"],
): EventGroupDto {
  const memberCount = members.length;
  return {
    id: row.id,
    eventKey: row.event_key,
    name: row.name,
    createdByWpUserId: Number(row.created_by_wp_user_id),
    membersCanAccept: Boolean(row.members_can_accept),
    stage: row.stage || "group_stage",
    competitionName: row.competition_name || "ICE UNDERWATER Warrior Kings",
    groupPhoto: publicHttpsUrl(row.group_photo_url || ""),
    memberCount,
    maxMembers: EVENT_GROUP_MAX_MEMBERS,
    spotsLeft: Math.max(0, EVENT_GROUP_MAX_MEMBERS - memberCount),
    members,
    pending,
    you,
    createdAt: toIso(row.created_at),
  };
}
