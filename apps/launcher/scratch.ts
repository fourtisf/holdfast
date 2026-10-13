import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
const require = createRequire(import.meta.url);
const sdk = require("@pump-fun/pump-sdk");
const { PUMP_SDK, getPumpProgram, newBondingCurve, getBuyV3TokenAmountFromQuoteAmount, getBuyV3QuoteAmountFromTokenAmount } = sdk;
const prog = getPumpProgram(new Connection("http://127.0.0.1:1"));
const enc = (name: string, value: any) => { const l = (prog.coder.accounts as any).accountLayouts.get(name); const buf = Buffer.alloc(8192); const n = l.layout.encode(value, buf); return Buffer.concat([Buffer.from(l.discriminator), buf.subarray(0, n)]); };
const pk = () => Keypair.generate().publicKey;
const global = {
  initialized: true, authority: pk(), feeRecipient: pk(),
  initialVirtualTokenReserves: new BN("1073000000000000"), initialVirtualSolReserves: new BN("30000000000"),
  initialRealTokenReserves: new BN("793100000000000"), tokenTotalSupply: new BN("1000000000000000"),
  feeBasisPoints: new BN(95), withdrawAuthority: pk(), enableMigrate: true, poolMigrationFee: new BN(15000001),
  creatorFeeBasisPoints: new BN(5), feeRecipients: Array.from({length:7}, pk), setCreatorAuthority: pk(), adminSetCreatorAuthority: pk(),
  createV2Enabled: true, whitelistPda: pk(), reservedFeeRecipient: pk(), mayhemModeEnabled: false, reservedFeeRecipients: Array.from({length:7}, pk),
  isCashbackEnabled: false, buybackFeeRecipients: Array.from({length:8}, pk), buybackBasisPoints: new BN(0), initialVirtualQuoteReserves: new BN("30000000000"),
  whitelistedQuoteMints: [PublicKey.default], creatorFeeConfigurable: false, maxConfigurableCreatorFeeBps: new BN(0), holderRewardClaimAuthority: PublicKey.default,
  isHolderRewardEnabled: false, maxCurveDepth: 0,
};
const gbuf = enc("global", global);
console.log("global len", gbuf.length);
const g2 = PUMP_SDK.decodeGlobal({ data: gbuf, lamports: 1, owner: prog.programId, executable: false });
console.log(g2.feeBasisPoints.toString(), g2.maxCurveDepth);
const fees = (p: number, c: number) => ({ lpFeeBps: new BN(0), protocolFeeBps: new BN(p), creatorFeeBps: new BN(c) });
const feeConfig = { bump: 255, admin: pk(), flatFees: fees(95, 5), feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: fees(95, 30) }], stableFeeTiers: [], exoticFlatFees: fees(0,0) };
let fbuf = enc("feeConfig", feeConfig);
console.log("fee len", fbuf.length);
fbuf = Buffer.concat([fbuf, Buffer.alloc(4097 - fbuf.length)]);
const f2 = PUMP_SDK.decodeFeeConfig({ data: fbuf, lamports: 1, owner: prog.programId, executable: false });
console.log(JSON.stringify(f2.feeTiers.map((t: any) => t.fees.protocolFeeBps.toString())));
const curve = { ...newBondingCurve(g2), creator: pk() };
const cbuf = enc("bondingCurve", curve);
console.log("curve len", cbuf.length);
const c2 = PUMP_SDK.decodeBondingCurve({ data: cbuf, lamports: 1, owner: prog.programId, executable: false });
const amount = new BN(1_000_000_000);
const tokens = getBuyV3TokenAmountFromQuoteAmount({ global: g2, feeConfig: f2, mintSupply: g2.tokenTotalSupply, bondingCurve: c2, amount, curveBaseTokenBalance: g2.tokenTotalSupply });
const cost = getBuyV3QuoteAmountFromTokenAmount({ global: g2, feeConfig: f2, mintSupply: g2.tokenTotalSupply, bondingCurve: c2, amount: tokens, curveBaseTokenBalance: g2.tokenTotalSupply });
console.log(tokens.toString(), cost.toString());
const user = pk(); const mint = pk();
const ixs = await PUMP_SDK.buyV3Instructions({ bondingCurve: c2, associatedUserAccountInfo: null, mint, user, amount: tokens, quoteAmount: cost, slippage: 0, buybackFeeRecipient: global.buybackFeeRecipients[0] });
console.log(ixs.length, ixs.map((i: any) => [i.programId.toBase58().slice(0,6), i.keys.length, i.data.length]));
const close = await PUMP_SDK.closeUserVolumeAccumulator(user);
console.log(close.keys.map((k: any) => k.pubkey.toBase58().slice(0,6)));
