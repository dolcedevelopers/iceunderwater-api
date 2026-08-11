import { config } from "../config.js";
import { httpJson } from "./http.js";
import { AppError } from "../lib/errors.js";

function wcAuthHeader(): string {
  return `Basic ${Buffer.from(`${config.WC_CONSUMER_KEY}:${config.WC_CONSUMER_SECRET}`).toString("base64")}`;
}

function wcUrl(path: string): string {
  return `${config.WP_BASE_URL}/wp-json/wc/v3${path}`;
}

export type WcProductInput = {
  name: string;
  type?: string;
  regular_price: string;
  description?: string;
  short_description?: string;
  manage_stock?: boolean;
  stock_quantity?: number;
  stock_status?: "instock" | "outofstock" | "onbackorder";
  status?: "publish" | "draft" | "private";
  catalog_visibility?: "visible" | "catalog" | "search" | "hidden";
  categories?: { id: number }[];
  images?: { id?: number; src?: string }[];
  meta_data?: { key: string; value: string | number }[];
};

export type WcProduct = {
  id: number;
  name: string;
  status: string;
  regular_price: string;
  price: string;
  stock_quantity: number | null;
  description: string;
  short_description: string;
  categories: { id: number; name: string }[];
  images: { id: number; src: string }[];
  meta_data: { key: string; value: unknown }[];
};

export async function createWcProduct(input: WcProductInput): Promise<WcProduct> {
  return httpJson<WcProduct>(wcUrl("/products"), {
    method: "POST",
    headers: { Authorization: wcAuthHeader() },
    body: { type: "simple", manage_stock: true, status: "publish", ...input },
  });
}

export async function updateWcProduct(id: number, input: Partial<WcProductInput>): Promise<WcProduct> {
  return httpJson<WcProduct>(wcUrl(`/products/${id}`), {
    method: "PUT",
    headers: { Authorization: wcAuthHeader() },
    body: input,
  });
}

export async function deleteWcProduct(id: number): Promise<void> {
  await httpJson(wcUrl(`/products/${id}?force=false`), {
    method: "DELETE",
    headers: { Authorization: wcAuthHeader() },
  });
}

export async function getWcProduct(id: number): Promise<WcProduct> {
  return httpJson<WcProduct>(wcUrl(`/products/${id}`), {
    headers: { Authorization: wcAuthHeader() },
  });
}

export async function listWcCategories(): Promise<{ id: number; name: string; count: number; image?: { src?: string } }[]> {
  return httpJson(wcUrl("/products/categories?per_page=100&hide_empty=false"), {
    headers: { Authorization: wcAuthHeader() },
  });
}

export async function updateWcOrderStatus(orderId: number, status: string): Promise<void> {
  await httpJson(wcUrl(`/orders/${orderId}`), {
    method: "PUT",
    headers: { Authorization: wcAuthHeader() },
    body: { status },
  });
}

export async function createWcRefund(orderId: number): Promise<void> {
  await httpJson(wcUrl(`/orders/${orderId}/refunds`), {
    method: "POST",
    headers: { Authorization: wcAuthHeader() },
    body: { api_refund: true },
  });
}

export async function pingWooCommerce(): Promise<boolean> {
  try {
    await httpJson(wcUrl("/system_status"), {
      headers: { Authorization: wcAuthHeader() },
      retries: 0,
      timeoutMs: 5000,
    });
    return true;
  } catch (error) {
    if (error instanceof AppError && error.status === 502) return false;
    // system_status may be forbidden; try products
    try {
      await httpJson(wcUrl("/products?per_page=1"), {
        headers: { Authorization: wcAuthHeader() },
        retries: 0,
        timeoutMs: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
