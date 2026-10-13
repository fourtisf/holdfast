/**
 * Data sizes of every account a launch creates, so the launch cost is rent math over real layouts
 * instead of hard-coded lamport amounts:
 * - Holdfast `CoinVault`: 8-byte discriminator + borsh size of the IDL struct (Anchor
 *   `space = 8 + CoinVault::INIT_SPACE`, no padding), computed from `idl/holdfast_vault.json`.
 * - pump.fun: Token-2022 mint with MetadataPointer + TokenMetadata (variable: name/symbol/uri),
 *   `BondingCurve` (`BONDING_CURVE_SIZE` from the SDK), `UserVolumeAccumulator` (137 bytes: the
 *   size pump allocates, docs/instructions/BUY.md "Rent for 137-byte account"; the IDL struct is
 *   shorter because pump reserves trailing space).
 * - Token accounts: SPL Token 165 bytes; Token-2022 ATAs carry ImmutableOwner (170 bytes).
 */
import { ACCOUNT_SIZE, ExtensionType, getAccountLen, getMintLen } from "@solana/spl-token";
import { HOLDFAST_IDL } from "@holdfast/chain";

import { pump } from "./pump.js";

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } } | { option: IdlType } | { vec: IdlType };
interface IdlTypeDef {
  name: string;
  type: { kind: string; fields?: { name: string; type: IdlType }[] };
}

const PRIMITIVE_SIZE: Record<string, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  f64: 8,
  u128: 16,
  i128: 16,
  pubkey: 32,
};

/** Borsh size of a fixed-size IDL type (throws on vec/string/option: not fixed). */
export function fixedBorshSize(type: IdlType, types: readonly IdlTypeDef[]): number {
  if (typeof type === "string") {
    const size = PRIMITIVE_SIZE[type];
    if (size === undefined) throw new Error(`type ${type} has no fixed size`);
    return size;
  }
  if ("array" in type) return fixedBorshSize(type.array[0], types) * type.array[1];
  if ("defined" in type) {
    const def = types.find((t) => t.name === type.defined.name);
    if (!def || def.type.kind !== "struct") throw new Error(`unsupported defined type ${type.defined.name}`);
    return (def.type.fields ?? []).reduce((sum, f) => sum + fixedBorshSize(f.type, types), 0);
  }
  throw new Error(`type ${JSON.stringify(type)} has no fixed size`);
}

/** Size of an Anchor account of the Holdfast program (discriminator included). */
export function holdfastAccountSize(name: string): number {
  const types = (HOLDFAST_IDL.types ?? []) as unknown as IdlTypeDef[];
  return 8 + fixedBorshSize({ defined: { name } }, types);
}

export const COIN_VAULT_SIZE = holdfastAccountSize("CoinVault");
export const SYSTEM_ACCOUNT_SIZE = 0;
export const SPL_TOKEN_ACCOUNT_SIZE = ACCOUNT_SIZE;
export const TOKEN_2022_ATA_SIZE = getAccountLen([ExtensionType.ImmutableOwner]);
export const PUMP_BONDING_CURVE_SIZE: number = pump.BONDING_CURVE_SIZE;
export const PUMP_USER_VOLUME_ACCUMULATOR_SIZE = 137;

/** pump.fun limits (docs/instructions/COIN_CREATION.md), in UTF-8 bytes as the program checks them. */
export const PUMP_MAX_NAME_BYTES = 32;
export const PUMP_MAX_SYMBOL_BYTES = 13;
export const PUMP_MAX_URI_BYTES = 200;

/** Token-2022 `TokenMetadata` value: update authority + mint + name + symbol + uri + empty additional_metadata. */
export function tokenMetadataLen(nameBytes: number, symbolBytes: number, uriBytes: number): number {
  return 32 + 32 + (4 + nameBytes) + (4 + symbolBytes) + (4 + uriBytes) + 4;
}

/** Final size of a `create_v2` mint: MetadataPointer + TokenMetadata TLV entries. */
export function pumpMintSize(nameBytes: number, symbolBytes: number, uriBytes: number): number {
  return getMintLen([ExtensionType.MetadataPointer], {
    [ExtensionType.TokenMetadata]: tokenMetadataLen(nameBytes, symbolBytes, uriBytes),
  });
}

export const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8");
