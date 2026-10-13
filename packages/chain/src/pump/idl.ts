import { createRequire } from "node:module";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { pumpAmmJson } from "@pump-fun/pump-swap-sdk";

/**
 * IDLs shipped with the official SDKs (pump-sdk 4.1.0 / pump-swap-sdk 2.1.0), so decoders always
 * match the installed SDK version. pump-sdk is loaded through `require`: its ESM build pulls an
 * ESM dependency that imports named exports from CommonJS anchor, which Node's ESM loader rejects.
 */

export type PumpProgram = "pump" | "pump_amm";

const require = createRequire(import.meta.url);

let pumpIdlCache: Idl | null = null;
const coders = new Map<PumpProgram, BorshCoder>();

export function pumpIdl(): Idl {
  pumpIdlCache ??= (require("@pump-fun/pump-sdk") as { pumpIdl: Idl }).pumpIdl;
  return pumpIdlCache;
}

export function pumpAmmIdl(): Idl {
  return pumpAmmJson as unknown as Idl;
}

export function idlFor(program: PumpProgram): Idl {
  return program === "pump" ? pumpIdl() : pumpAmmIdl();
}

export function coderFor(program: PumpProgram): BorshCoder {
  let coder = coders.get(program);
  if (!coder) {
    coder = new BorshCoder(idlFor(program));
    coders.set(program, coder);
  }
  return coder;
}

/** Anchor `emit_cpi!` marker: the self-CPI instruction data starts with EVENT_IX_TAG (u64 LE). */
export const EVENT_IX_TAG_LE = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export function eventDiscriminator(program: PumpProgram, eventName: string): Uint8Array {
  const event = idlFor(program).events?.find((e) => e.name === eventName);
  if (!event) throw new Error(`${program} IDL has no event ${eventName}`);
  return Uint8Array.from(event.discriminator);
}
