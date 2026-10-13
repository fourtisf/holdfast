import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageKind = { ext: "png" | "jpg" | "gif" | "webp"; mime: string };

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/** Identify an image by its magic bytes (the declared content type is not trusted). */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mime: "image/png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a") return { ext: "gif", mime: "image/gif" };
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}

/** Store under a content-hash name (idempotent). Returns the file name relative to the store. */
export async function storeImage(dir: string, buf: Buffer, kind: ImageKind): Promise<string> {
  const name = `${createHash("sha256").update(buf).digest("hex")}.${kind.ext}`;
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) await writeFile(path, buf, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  return name;
}
