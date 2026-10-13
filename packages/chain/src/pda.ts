import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  HOLDFAST_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  WSOL_MINT,
} from "./constants.js";

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

// ---- Holdfast ----------------------------------------------------------------------------------
export const configPda = (program = HOLDFAST_PROGRAM_ID) => pda([Buffer.from("config")], program);
export const vaultPda = (mint: PublicKey, program = HOLDFAST_PROGRAM_ID) => pda([Buffer.from("vault"), mint.toBuffer()], program);
export const treasuryPda = (mint: PublicKey, program = HOLDFAST_PROGRAM_ID) => pda([Buffer.from("treasury"), mint.toBuffer()], program);
export function roundPda(mint: PublicKey, roundId: bigint, program = HOLDFAST_PROGRAM_ID) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(roundId);
  return pda([Buffer.from("round"), mint.toBuffer(), id], program);
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

// ---- pump.fun ------------------------------------------------------------------------------------
export const bondingCurvePda = (mint: PublicKey) => pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
export const bondingCurveV2Pda = (mint: PublicKey) => pda([Buffer.from("bonding-curve-v2"), mint.toBuffer()], PUMP_PROGRAM_ID);
export const creatorVaultPda = (creator: PublicKey) => pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);
export const pumpPoolAuthorityPda = (mint: PublicKey) => pda([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM_ID);

// ---- PumpSwap --------------------------------------------------------------------------------------
export function poolPda(index: number, owner: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(index);
  return pda([Buffer.from("pool"), idx, owner.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM_PROGRAM_ID);
}
/** The pool pump.fun's `migrate` creates for a graduated SOL-paired coin. */
export const canonicalPoolPda = (mint: PublicKey) => poolPda(0, pumpPoolAuthorityPda(mint), mint, WSOL_MINT);
export const coinCreatorVaultAuthorityPda = (coinCreator: PublicKey) =>
  pda([Buffer.from("creator_vault"), coinCreator.toBuffer()], PUMP_AMM_PROGRAM_ID);
