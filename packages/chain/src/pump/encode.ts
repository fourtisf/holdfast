import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import type { IdlField, IdlType, IdlTypeDef } from "@coral-xyz/anchor/dist/cjs/idl.js";
import { coderFor, EVENT_IX_TAG_LE, eventDiscriminator, idlFor, type PumpProgram } from "./idl.js";

/**
 * Encoders for pump / PumpSwap events, mainly for fixtures and tests: fields are given in IDL
 * (snake_case) names with plain JS values (bigint | number | string for integers, base58 for
 * pubkeys); anything omitted gets a zero value. The bytes go through the same anchor coder the
 * decoders use, so a round trip exercises the real layout.
 */

type Plain = Record<string, unknown>;

function typeDef(program: PumpProgram, name: string): IdlTypeDef {
  const def = idlFor(program).types?.find((t) => t.name === name);
  if (!def) throw new Error(`${program} IDL has no type ${name}`);
  return def;
}

const INTEGER = new Set(["u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128"]);
const WIDE = new Set(["u64", "u128", "i64", "i128"]);

function toAnchor(program: PumpProgram, type: IdlType, value: unknown): unknown {
  if (typeof type === "string") {
    if (INTEGER.has(type)) {
      const v = value === undefined || value === null ? 0 : value;
      return WIDE.has(type) ? new BN(String(v)) : Number(v);
    }
    if (type === "pubkey") return value instanceof PublicKey ? value : new PublicKey((value as string | undefined) ?? PublicKey.default);
    if (type === "bool") return Boolean(value);
    if (type === "string") return (value as string | undefined) ?? "";
    if (type === "bytes") return Buffer.from((value as Uint8Array | undefined) ?? []);
    throw new Error(`unsupported IDL type ${type}`);
  }
  if ("vec" in type) return ((value as unknown[] | undefined) ?? []).map((v) => toAnchor(program, type.vec, v));
  if ("option" in type) return value === undefined || value === null ? null : toAnchor(program, type.option, value);
  if ("array" in type) {
    const [inner, len] = type.array as [IdlType, number];
    const arr = (value as unknown[] | undefined) ?? Array.from({ length: len }, () => undefined);
    return arr.map((v) => toAnchor(program, inner, v));
  }
  if ("defined" in type) {
    const def = typeDef(program, type.defined.name);
    if (def.type.kind !== "struct") throw new Error(`unsupported defined kind ${def.type.kind}`);
    return structToAnchor(program, (def.type.fields ?? []) as IdlField[], (value as Plain | undefined) ?? {});
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(type)}`);
}

function structToAnchor(program: PumpProgram, fields: IdlField[], value: Plain): Plain {
  const out: Plain = {};
  for (const f of fields) out[f.name] = toAnchor(program, f.type, value[f.name]);
  return out;
}

/** `discriminator ‖ borsh(fields)` for event `name` of `program`. */
export function encodePumpEvent(program: PumpProgram, name: string, fields: Plain = {}): Uint8Array {
  const def = typeDef(program, name);
  if (def.type.kind !== "struct") throw new Error(`${name} is not a struct`);
  const data = structToAnchor(program, (def.type.fields ?? []) as IdlField[], fields);
  const body = coderFor(program).types.encode(name, data);
  return Buffer.concat([Buffer.from(eventDiscriminator(program, name)), body]);
}

/** Instruction data of the anchor `emit_cpi!` self-invocation carrying `eventBytes`. */
export function emitCpiData(eventBytes: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(EVENT_IX_TAG_LE), Buffer.from(eventBytes)]);
}

/** The `Program data:` log line anchor `emit!` writes for `eventBytes`. */
export function programDataLog(eventBytes: Uint8Array): string {
  return `Program data: ${Buffer.from(eventBytes).toString("base64")}`;
}
