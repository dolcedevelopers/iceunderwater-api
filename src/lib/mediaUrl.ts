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

/**
 * Preserve the URL WordPress actually stored; invented derivatives can be missing.
 */
export function toCatalogImageUrl(value: string | null | undefined): string {
  return publicHttpsUrl(value);
}

/** Pick the closest width from a srcset string (e.g. "a.jpg 527w, a-medium.jpg 300w"). */
export function pickSrcsetUrl(srcset: string | null | undefined, targetWidth = 400): string {
  const parts = String(srcset || "")
    .split(",")
    .map((part) => {
      const match = part.trim().match(/^(https?:\/\/\S+)\s+(\d+)w$/i);
      if (!match) return null;
      return { url: publicHttpsUrl(match[1]), width: Number(match[2]) };
    })
    .filter((row): row is { url: string; width: number } => Boolean(row?.url));

  if (!parts.length) return "";
  const bigEnough = parts.filter((row) => row.width >= targetWidth).sort((a, b) => a.width - b.width);
  if (bigEnough[0]) return bigEnough[0].url;
  return parts.sort((a, b) => b.width - a.width)[0]!.url;
}
