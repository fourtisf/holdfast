import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PinataMetadataStorage, type FetchFn } from "../src/storage.js";
import type { LaunchForm } from "../src/metadata.js";

const BASE = "https://api.holdfast.test/metadata";
const CID_IMAGE = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const CID_JSON = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(responses: { status: number; body: string }[]) {
  const storeDir = mkdtempSync(join(tmpdir(), "holdfast-pin-"));
  dirs.push(storeDir);
  writeFileSync(join(storeDir, "abc.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const calls: { url: string; auth: string; file: Blob; name: string }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const file = init.body.get("file") as File;
    calls.push({ url, auth: init.headers.Authorization!, file, name: file.name });
    const r = responses.shift()!;
    return { ok: r.status < 300, status: r.status, text: async () => r.body };
  };
  const storage = new PinataMetadataStorage({ storeDir, publicBaseUrl: BASE, siteUrl: "https://holdfast.test" }, { jwt: "jwt-123", gatewayUrl: "https://ipfs.io/" }, fetchFn);
  return { storage, calls };
}

const form: LaunchForm = {
  name: "Pinned",
  symbol: "PIN",
  description: "on ipfs",
  imageUrl: `${BASE}/abc.png`,
  socials: { x: "https://x.com/pin" },
  triggerBps: 2500,
};

describe("PinataMetadataStorage", () => {
  it("pins the uploaded image, then the metadata JSON pointing at it, and returns gateway URIs", async () => {
    const { storage, calls } = setup([
      { status: 200, body: JSON.stringify({ IpfsHash: CID_IMAGE }) },
      { status: 200, body: JSON.stringify({ IpfsHash: CID_JSON }) },
    ]);
    const res = await storage.publish(form);
    expect(res).toEqual({ uri: `https://ipfs.io/ipfs/${CID_JSON}`, imageUri: `https://ipfs.io/ipfs/${CID_IMAGE}` });
    expect(calls.map((c) => c.name)).toEqual(["abc.png", "PIN-metadata.json"]);
    expect(calls.every((c) => c.auth === "Bearer jwt-123")).toBe(true);
    const json = JSON.parse(await calls[1]!.file.text());
    expect(json).toMatchObject({ name: "Pinned", symbol: "PIN", image: `https://ipfs.io/ipfs/${CID_IMAGE}`, twitter: "https://x.com/pin", showName: true });
    expect(res.uri.length).toBe("https://ipfs.io/ipfs/".length + 59);
  });

  it("fails on HTTP errors and on CIDs that are not CIDv1 (the launch cost depends on the URI length)", async () => {
    await expect(setup([{ status: 401, body: "unauthorized" }]).storage.publish(form)).rejects.toThrow(/HTTP 401/);
    await expect(setup([{ status: 200, body: JSON.stringify({ IpfsHash: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" }) }]).storage.publish(form)).rejects.toThrow(/unexpected CID/);
  });
});
