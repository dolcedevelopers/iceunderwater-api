import type { FastifyRequest } from "fastify";
import { validationError } from "./errors.js";

export async function readImageFromRequest(
  request: FastifyRequest,
): Promise<{ buffer: Buffer; filename: string }> {
  const body = request.body as { data?: string; filename?: string } | undefined;
  if (body && typeof body.data === "string" && body.data.length > 0) {
    const buffer = Buffer.from(body.data, "base64");
    if (!buffer.length) throw validationError("Image file is required.");
    return { buffer, filename: body.filename?.trim() || "upload.jpg" };
  }

  const file = await request.file().catch(() => undefined);
  if (!file) throw validationError("Image file is required.");
  return { buffer: await file.toBuffer(), filename: file.filename || "upload.jpg" };
}
