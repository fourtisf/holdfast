import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../context.js";
import { HttpError } from "../errors.js";
import { MAX_IMAGE_BYTES, sniffImage, storeImage } from "../uploads.js";

export function uploadRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post("/uploads/image", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    if (!req.isMultipart()) throw new HttpError(415, "Expected multipart/form-data with a `file` field");
    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
    if (!file || file.fieldname !== "file") throw new HttpError(400, "Missing `file` field");
    const buf = await file.toBuffer();
    if (file.file.truncated || buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Image must be at most 5 MB");
    if (buf.length === 0) throw new HttpError(400, "Empty file");
    const kind = sniffImage(buf);
    if (!kind) throw new HttpError(415, "Unsupported image type (png, jpg, gif or webp)");
    const name = await storeImage(ctx.config.metadataDir, buf, kind);
    return { imageUrl: `${ctx.config.publicMetadataBaseUrl}/${name}` };
  });
}
