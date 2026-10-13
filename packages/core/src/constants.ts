/**
 * Mechanism constants. These mirror the on-chain program (programs/holdfast-vault/src/constants.rs)
 * and the spec table in docs/SPEC.md §2. Changing any of them is a protocol change.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Creator-fee split, in basis points. Must sum to 10_000. Dev/launcher share is 0 by construction. */
export const SPLIT_FLOOR_BPS = 6_000;
export const SPLIT_HOLDER_BPS = 3_000;
export const SPLIT_BURN_BPS = 1_000;

/** Allowed floor triggers (floor = ATH × (1 − trigger)). Chosen at launch, immutable. */
export const TRIGGER_OPTIONS_BPS = [1_500, 2_500, 3_500] as const;
export type TriggerBps = (typeof TRIGGER_OPTIONS_BPS)[number];
export const DEFAULT_TRIGGER_BPS: TriggerBps = 2_500;

/** Each defend step spends this share of the floor vault's SOL. */
export const DEFEND_STEP_BPS = 1_000;

/** Payout cadence. Rounds are aligned to wall-clock multiples of this interval (UTC epoch). */
export const ROUND_INTERVAL_SECONDS = 120;

/** Hold-time weight: 0.1× at purchase, rising linearly to 1.0× after 168 hours (7 days). */
export const WEIGHT_MIN_PPM = 100_000n; // 0.1 in parts-per-million
export const WEIGHT_MAX_PPM = 1_000_000n; // 1.0
export const WEIGHT_RAMP_SECONDS = 168n * 3600n;

/** Launch cost: network + account rent. User sends SOL to a deposit address; the rest is refunded. */
export const LAUNCH_FEE_LAMPORTS = 15_000_000n; // 0.015 SOL

/** Fixed-point scale used for prices (lamports per base unit × 1e18), same as on-chain PRICE_SCALE. */
export const PRICE_SCALE = 1_000_000_000_000_000_000n;

/** pump.fun coins: 1B supply with 6 decimals. */
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_TOTAL_SUPPLY_BASE_UNITS = 1_000_000_000_000_000n;

/** Rent-exempt minimum for a 0-data system account. A first SOL transfer to an empty wallet must be ≥ this. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
