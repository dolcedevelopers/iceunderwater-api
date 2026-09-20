import { config } from "../config.js";
import { httpJson } from "./http.js";
import { AppError, authRequired } from "../lib/errors.js";
import { normalizeEmail } from "../lib/ids.js";

export type WpVerifiedUser = {
  wpUserId: number;
  email: string;
  displayName: string;
  roles: string[];
};

/** Verify credentials via the mu-plugin bridge (shared secret). Never stores the password. */
export async function verifyWpCredentials(email: string, password: string): Promise<WpVerifiedUser> {
  const payload = await httpJson<{
    wpUserId: number;
    email: string;
    displayName: string;
    roles: string[];
  }>(`${config.WP_BASE_URL}/wp-json/iuw-bridge/v1/verify`, {
    method: "POST",
    headers: { "X-IUW-Bridge-Secret": config.WP_BRIDGE_SECRET },
    body: { email: normalizeEmail(email), password },
    retries: 1,
  });

  if (!payload.wpUserId) throw authRequired("The login details are incorrect.");
  return {
    wpUserId: payload.wpUserId,
    email: normalizeEmail(payload.email),
    displayName: payload.displayName || "",
    roles: payload.roles || [],
  };
}

/** Customer path: accept a site token and resolve the WordPress user once. */
export async function resolveSiteToken(siteToken: string): Promise<WpVerifiedUser> {
  try {
    const me = await httpJson<{ user: { id: number; email: string; display_name?: string } }>(
      `${config.WP_BASE_URL}/wp-json/ice-underwater/v1/me`,
      {
        headers: { Authorization: `Bearer ${siteToken}` },
        retries: 1,
      },
    );
    return {
      wpUserId: me.user.id,
      email: normalizeEmail(me.user.email),
      displayName: me.user.display_name || "",
      roles: ["customer"],
    };
  } catch {
    throw authRequired("Please sign in again.");
  }
}

export async function registerWpCustomer(email: string, password: string, firstName: string): Promise<WpVerifiedUser> {
  const clean = normalizeEmail(email);
  try {
    const payload = await httpJson<{ token?: string; user: { id: number; email: string; display_name?: string } }>(
      `${config.WP_BASE_URL}/wp-json/api/flutter_user/register`,
      {
        method: "POST",
        body: {
          username: clean,
          email: clean,
          user_email: clean,
          user_login: clean.split("@")[0]?.replace(/[^a-z0-9]/gi, "") || "customer",
          user_pass: password,
          first_name: firstName,
        },
        retries: 1,
      },
    );
    return {
      wpUserId: payload.user.id,
      email: normalizeEmail(payload.user.email || clean),
      displayName: payload.user.display_name || firstName,
      roles: ["customer"],
    };
  } catch {
    const fallback = await httpJson<{ token?: string; user: { id: number; email: string; display_name?: string } }>(
      `${config.WP_BASE_URL}/wp-json/ice-underwater/v1/register`,
      {
        method: "POST",
        body: { email: clean, username: clean, password, first_name: firstName },
        retries: 1,
      },
    );
    return {
      wpUserId: fallback.user.id,
      email: normalizeEmail(fallback.user.email || clean),
      displayName: fallback.user.display_name || firstName,
      roles: ["customer"],
    };
  }
}

export async function createWpUserViaBridge(input: {
  email: string;
  password: string;
  displayName: string;
  roles: string[];
}): Promise<WpVerifiedUser> {
  const payload = await httpJson<WpVerifiedUser>(`${config.WP_BASE_URL}/wp-json/iuw-bridge/v1/create-user`, {
    method: "POST",
    headers: { "X-IUW-Bridge-Secret": config.WP_BRIDGE_SECRET },
    body: input,
    retries: 1,
  });
  if (!payload.wpUserId) throw new AppError(502, "UPSTREAM_ERROR", "Could not create WordPress user");
  return { ...payload, email: normalizeEmail(payload.email) };
}

export async function sendWcInvoice(orderId: number): Promise<void> {
  await httpJson(`${config.WP_BASE_URL}/wp-json/iuw-bridge/v1/send-invoice`, {
    method: "POST",
    headers: { "X-IUW-Bridge-Secret": config.WP_BRIDGE_SECRET },
    body: { orderId },
    retries: 2,
  });
}

export async function uploadWpMedia(buffer: Buffer, filename: string, mime: string): Promise<{ id: number; sourceUrl: string }> {
  // WooCommerce consumer keys do not authenticate /wp/v2/media. Prefer the mu-plugin bridge.
  try {
    const payload = await httpJson<{ id: number; sourceUrl?: string; source_url?: string }>(
      `${config.WP_BASE_URL}/wp-json/iuw-bridge/v1/upload-media`,
      {
        method: "POST",
        headers: { "X-IUW-Bridge-Secret": config.WP_BRIDGE_SECRET },
        body: {
          filename,
          mime,
          data: buffer.toString("base64"),
        },
        retries: 1,
        timeoutMs: 30_000,
      },
    );
    const sourceUrl = payload.sourceUrl || payload.source_url;
    if (payload.id && sourceUrl) return { id: payload.id, sourceUrl };
  } catch {
    // Fall through to WP REST in case Application Passwords were wired to the WC key user.
  }

  const auth = Buffer.from(`${config.WC_CONSUMER_KEY}:${config.WC_CONSUMER_SECRET}`).toString("base64");
  const response = await fetch(`${config.WP_BASE_URL}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": mime,
    },
    body: buffer,
  });
  const payload = (await response.json().catch(() => ({}))) as { id?: number; source_url?: string; message?: string };
  if (!response.ok || !payload.id || !payload.source_url) {
    throw new AppError(
      502,
      "UPSTREAM_ERROR",
      payload.message || "Image upload failed. Update the IUW API bridge mu-plugin so /upload-media is available.",
      { expose: true },
    );
  }
  return { id: payload.id, sourceUrl: payload.source_url };
}

export async function pingWordpress(): Promise<boolean> {
  try {
    // Shared hosting round-trips from Render regularly exceed 5s; keep this above that.
    const response = await fetch(`${config.WP_BASE_URL}/wp-json`, { signal: AbortSignal.timeout(12000) });
    return response.ok;
  } catch {
    return false;
  }
}
