import sharp from "sharp";
import { config } from "../config.js";
import { validationError } from "../lib/errors.js";
import { uploadWpMedia } from "../clients/wordpress.js";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function uploadImageBuffer(buffer: Buffer, filename: string): Promise<{ url: string; mediaId: number }> {
  if (buffer.byteLength > config.UPLOAD_MAX_BYTES) {
    throw validationError("Image is too large.");
  }

  // Re-encode to JPEG, strip EXIF, reject non-images.
  let processed: Buffer;
  try {
    processed = await sharp(buffer, { failOn: "error" })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw validationError("Only JPEG, PNG or WebP images are accepted.");
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[^.]+$/, "") + ".jpg";
  const uploaded = await uploadWpMedia(processed, safeName, "image/jpeg");
  if (!ALLOWED.has("image/jpeg")) throw validationError("Unsupported image type.");
  return { url: uploaded.sourceUrl, mediaId: uploaded.id };
}
