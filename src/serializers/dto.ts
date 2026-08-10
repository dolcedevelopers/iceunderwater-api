import { centsToRands } from "../lib/money.js";

export type SupplierDto = {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  city: string;
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
  id: string;
  reference: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  supplierId: string;
  supplierName: string;
  items: number;
  total: number;
  status: "paid" | "pending" | "refunded" | "failed";
  method: string;
  createdAt: string;
  receiptSentAt: string;
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
    logo: row.logo_url || "",
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

export function mapTransaction(row: {
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
}): TransactionDto {
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_wp_user_id != null ? String(row.customer_wp_user_id) : "",
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    items: row.items,
    total: centsToRands(row.total_cents),
    status: row.status,
    method: row.method,
    createdAt: toIso(row.created_at),
    receiptSentAt: row.receipt_sent_at ? toIso(row.receipt_sent_at) : "",
  };
}
