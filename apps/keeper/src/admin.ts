/**
 * Admin CLI for the vault program's Config. None of these instructions can move funds; the platform
 * treasury only decides where the platform's own 10% share is swept.
 *
 *   pnpm --filter @holdfast/keeper admin -- <command> [args] --rpc <url> --signer <keypair.json>
 *
 *   show                                   print the Config account
 *   init <keeper> <launcher> [params.json] create Config (signer must be the program upgrade authority)
 *   set-keeper <pubkey> | set-launcher <pubkey>
 *   set-params <params.json>               camelCase fields of ProgramParams (see DEFAULT_PARAMS)
 *   set-hold-mint <mint>                   one-time
 *   set-platform-treasury <pubkey>         receives the platform share (a multisig vault)
 *   pause | unpause
 *   transfer-admin <pubkey> | accept-admin
 *
 * `--priority <micro-lamports per CU>` (default 100000) sets the priority fee; a transaction whose blockhash expires
 * before it lands is sent again (up to 4 times).
 *
 * Multisig admins (Squads): add `--print --as <ADMIN_PUBKEY>` to print the instruction (program id,
 * accounts, base64 data) instead of sending it, for a multisig transaction proposal. No signer needed.
 */
import { readFileSync } from "node:fs";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  DEFAULT_PARAMS,
  acceptAdminIx,
  initializeIx,
  setHoldMintIx,
  setKeeperIx,
  setLauncherIx,
  setParamsIx,
  setPausedIx,
  setPlatformTreasuryIx,
  transferAdminIx,
  type ProgramParams,
} from "@holdfast/chain";

import { Web3Chain } from "./chain.js";
import { loadKeypair } from "./config.js";
import { loadProgramConfig } from "./crank.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readParams(path: string | undefined): ProgramParams {
  if (!path) return DEFAULT_PARAMS;
  return { ...DEFAULT_PARAMS, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ProgramParams>) };
}

async function main() {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  const [command, ...args] = positional;
  const rpc = flag("rpc") ?? process.env.SOLANA_RPC_URL;
  if (!command || !rpc) throw new Error("usage: admin <command> [args] --rpc <url> --signer <keypair.json>");
  const connection = new Connection(rpc, "confirmed");
  const chain = new Web3Chain(connection, Number(flag("priority") ?? 100_000));

  if (command === "show") {
    console.log(JSON.stringify(await loadProgramConfig(chain), (_, v) => (v instanceof PublicKey ? v.toBase58() : v), 2));
    return;
  }

  const print = process.argv.includes("--print");
  const as = flag("as");
  if (print && !as) throw new Error("--print needs --as <ADMIN_PUBKEY> (the multisig vault that will sign)");
  const signerPath = flag("signer");
  if (!print && !signerPath) throw new Error("--signer <keypair.json> is required");
  const signer = print ? null : loadKeypair(signerPath!);
  const me = print ? new PublicKey(as!) : signer!.publicKey;
  const key = (i: number) => {
    const v = args[i];
    if (!v) throw new Error(`missing argument ${i + 1}`);
    return new PublicKey(v);
  };

  let ix: TransactionInstruction;
  switch (command) {
    case "init":
      ix = initializeIx(me, key(0), key(1), readParams(args[2]));
      break;
    case "set-keeper":
      ix = setKeeperIx(me, key(0));
      break;
    case "set-launcher":
      ix = setLauncherIx(me, key(0));
      break;
    case "set-params":
      ix = setParamsIx(me, readParams(args[0]));
      break;
    case "set-hold-mint":
      ix = setHoldMintIx(me, key(0));
      break;
    case "set-platform-treasury":
      ix = setPlatformTreasuryIx(me, key(0));
      break;
    case "pause":
    case "unpause":
      ix = setPausedIx(me, command === "pause");
      break;
    case "transfer-admin":
      ix = transferAdminIx(me, key(0));
      break;
    case "accept-admin":
      ix = acceptAdminIx(me);
      break;
    default:
      throw new Error(`unknown command ${command}`);
  }
  if (print) {
    console.log(
      JSON.stringify(
        {
          programId: ix.programId.toBase58(),
          accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
          data: Buffer.from(ix.data).toString("base64"),
        },
        null,
        2,
      ),
    );
    return;
  }
  // Without enough priority a transaction can expire unconfirmed; an expired blockhash can no longer land, so
  // sending it again is safe (unless it did land and only the confirmation was missed, which is checked first).
  for (let attempt = 1; ; attempt++) {
    try {
      const sig = await chain.send([ix], [signer!], { computeUnits: 100_000 });
      console.log(`${command}: ${sig}`);
      return;
    } catch (err) {
      const message = (err as Error).message;
      if (!/expired|block height exceeded|blockhash not found/i.test(message) || attempt >= 4) throw err;
      const sig = /Signature (\w+)/.exec(message)?.[1];
      if (sig) {
        const { value } = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (value && !value.err && value.confirmationStatus) {
          console.log(`${command}: ${sig}`);
          return;
        }
      }
      console.log(`attempt ${attempt} expired before landing, sending again`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
