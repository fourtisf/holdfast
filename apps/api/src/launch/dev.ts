import { Keypair } from "@solana/web3.js";
import type { DepositAllocator } from "./deposit.js";

/** Local development only: random, unrecoverable deposit addresses (never use with real funds). */
export const randomDepositAllocator: DepositAllocator = async () => Keypair.generate().publicKey.toBase58();
