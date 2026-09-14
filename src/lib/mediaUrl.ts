/** WordPress GUIDs are often stored as http:// — mobile clients need https. */
export function publicHttpsUrl(value: string | null | undefined): string {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url;
}

export function isHostedImageUrl(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test(String(value || "").trim());
}
