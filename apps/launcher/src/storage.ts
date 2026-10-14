/**
 * Where a coin's pump.fun metadata lives (`create_v2`'s `uri`, read by pump.fun, wallets and
 * explorers forever after):
 * - `local`: content-addressed JSON in METADATA_STORE, served by our API. Fine for development; in
 *   production the coin's metadata disappears with the server.
 * - `pinata`: the image and the JSON are pinned to IPFS through Pinata, and the URI points at a public
 *   IPFS gateway (`<gateway>/ipfs/<cid>`), so it outlives Holdfast. Both are content-addressed, so a
 *   retry pins the same bytes and gets the same CID.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IPFS_CID_V1_LENGTH, type MetadataStorageKind } from "@holdfast/chain";

import { buildMetadataJson, normalizeBaseUrl, validateImageUrl, writeMetadata, type LaunchForm, type MetadataSettings } from "./metadata.js";

export interface PublishedMetadata {
  /** `create_v2`'s uri. */
  uri: string;
  /** Image URL inside the metadata JSON (null without an image). */
  imageUri: string | null;
}

export interface MetadataStorage {
  readonly kind: MetadataStorageKind;
  publish(form: LaunchForm): Promise<PublishedMetadata>;
}

export class LocalMetadataStorage implements MetadataStorage {
  readonly kind = "local" as const;
  constructor(private readonly settings: MetadataSettings) {}

  async publish(form: LaunchForm): Promise<PublishedMetadata> {
    const doc = await writeMetadata(buildMetadataJson(form, this.settings.siteUrl), this.settings);
    return { uri: doc.uri, imageUri: form.imageUrl };
  }
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface PinataSettings {
  jwt: string;
  /** Public gateway for URIs, e.g. https://ipfs.io (no trailing slash). */
  gatewayUrl: string;
  /** Pinning endpoint (default Pinata's pinFileToIPFS). */
  endpoint?: string;
  timeoutMs?: number;
}

export const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

export class PinataMetadataStorage implements MetadataStorage {
  readonly kind = "pinata" as const;
  private readonly fetch: FetchFn;

  constructor(
    private readonly settings: MetadataSettings,
    private readonly pinata: PinataSettings,
    fetchFn?: FetchFn,
  ) {
    this.fetch = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  /** The uploaded image's bytes: uploads live in METADATA_STORE, shared with the API. */
  private async imageBytes(imageUrl: string): Promise<{ bytes: Buffer; name: string }> {
    const url = validateImageUrl(imageUrl, this.settings.publicBaseUrl)!;
    const base = new URL(`${normalizeBaseUrl(this.settings.publicBaseUrl)}/`);
    const relative = decodeURIComponent(new URL(url).pathname.slice(base.pathname.length));
    return { bytes: await readFile(join(this.settings.storeDir, relative)), name: relative };
  }

  async pin(bytes: Buffer, name: string, contentType: string): Promise<string> {
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), name);
    body.append("pinataMetadata", JSON.stringify({ name }));
    body.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const res = await this.fetch(this.pinata.endpoint ?? PINATA_PIN_FILE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.pinata.jwt}` },
      body,
      signal: AbortSignal.timeout(this.pinata.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`IPFS pin of ${name} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    let cid: unknown;
    try {
      cid = (JSON.parse(text) as { IpfsHash?: unknown }).IpfsHash;
    } catch {
      throw new Error(`IPFS pin of ${name}: unexpected response ${text.slice(0, 200)}`);
    }
    // CIDv1 base32 has a fixed length; the launch cost (mint size) is computed from it.
    if (typeof cid !== "string" || cid.length !== IPFS_CID_V1_LENGTH || !/^b[a-z2-7]+$/.test(cid)) {
      throw new Error(`IPFS pin of ${name} returned an unexpected CID ${String(cid)}`);
    }
    return cid;
  }

  uriOf(cid: string): string {
    return `${this.pinata.gatewayUrl.replace(/\/+$/, "")}/ipfs/${cid}`;
  }

  async publish(form: LaunchForm): Promise<PublishedMetadata> {
    let imageUri: string | null = null;
    if (form.imageUrl) {
      const { bytes, name } = await this.imageBytes(form.imageUrl);
      imageUri = this.uriOf(await this.pin(bytes, name, contentTypeOf(name)));
    }
    const json = buildMetadataJson({ ...form, imageUrl: imageUri }, this.settings.siteUrl);
    const cid = await this.pin(Buffer.from(JSON.stringify(json), "utf8"), `${form.symbol}-metadata.json`, "application/json");
    return { uri: this.uriOf(cid), imageUri };
  }
}

function contentTypeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "application/octet-stream";
}
