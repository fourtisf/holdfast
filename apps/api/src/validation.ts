import { z } from "zod";
import { PublicKey } from "@solana/web3.js";

export const base58Address = z
  .string()
  .trim()
  .refine((v) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
    try {
      return new PublicKey(v).toBytes().length === 32;
    } catch {
      return false;
    }
  }, "invalid address");

/** Optional integer query param with bounds and default. */
export const intParam = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);

export const optionalMs = z.coerce.number().int().nonnegative().optional();
