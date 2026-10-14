//! Pure arithmetic shared by the instructions. Everything is checked; no float.

use crate::constants::*;
use crate::state::Observation;

/// The four buckets of one fee collection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeSplit {
    pub floor: u64,
    pub holder: u64,
    pub creator: u64,
    pub burn: u64,
}

/// 50 / 25 / 15 / 10 split. Rounding dust goes to the floor bucket so the parts always sum to `amount`.
pub fn split_fees(amount: u64) -> FeeSplit {
    let holder = bps_of(amount, SPLIT_HOLDER_BPS);
    let creator = bps_of(amount, SPLIT_CREATOR_BPS);
    let burn = bps_of(amount, SPLIT_BURN_BPS);
    FeeSplit { floor: amount - holder - creator - burn, holder, creator, burn }
}

pub fn bps_of(amount: u64, bps: u64) -> u64 {
    (amount as u128 * bps as u128 / BPS_DENOMINATOR as u128) as u64
}

/// floor = ATH × (1 − trigger)
pub fn floor_from_ath(ath: u128, trigger_bps: u16) -> Option<u128> {
    let keep = (BPS_DENOMINATOR - trigger_bps as u64) as u128;
    ath.checked_mul(keep).map(|v| v / BPS_DENOMINATOR as u128)
}

/// Spot price, lamports per base unit × PRICE_SCALE.
pub fn price(quote: u128, base: u128) -> Option<u128> {
    if base == 0 {
        return None;
    }
    quote.checked_mul(PRICE_SCALE).map(|v| v / base)
}

/// `price × (1 + bps)`.
pub fn price_with_tolerance(price: u128, bps: u16) -> Option<u128> {
    price.checked_mul(BPS_DENOMINATOR as u128 + bps as u128).map(|v| v / BPS_DENOMINATOR as u128)
}

/// Fewest base units that may be accepted for `lamports` so that the per-unit price stays ≤ `max_price`.
/// ceil(lamports × PRICE_SCALE / max_price)
pub fn min_tokens_at_price(lamports: u64, max_price: u128) -> Option<u64> {
    if max_price == 0 {
        return None;
    }
    let num = (lamports as u128).checked_mul(PRICE_SCALE)?;
    let q = num.div_ceil(max_price);
    u64::try_from(q).ok()
}

/// Time-weighted average of the step function defined by the observations over `[now − window, now]`.
/// Returns `None` unless the observations cover the whole window without a gap larger than `max_gap`
/// (the newest observation must also be at most `max_gap` old).
pub fn twap(newest_first: impl Iterator<Item = Observation>, now: i64, window: i64, max_gap: i64) -> Option<u128> {
    if window <= 0 {
        return None;
    }
    let start = now.checked_sub(window)?;
    let mut segment_end = now;
    let mut weighted: u128 = 0;
    let mut covered = false;
    for obs in newest_first {
        if obs.ts > segment_end {
            return None; // out of order
        }
        if segment_end - obs.ts > max_gap {
            return None;
        }
        let seg_start = obs.ts.max(start);
        let dur = (segment_end - seg_start) as u128;
        weighted = weighted.checked_add(obs.price.checked_mul(dur)?)?;
        if obs.ts <= start {
            covered = true;
            break;
        }
        segment_end = obs.ts;
    }
    if !covered {
        return None;
    }
    Some(weighted / window as u128)
}

/// ATH state machine. A TWAP above the ATH becomes a candidate; the candidate is the lowest TWAP
/// seen while it stays above the ATH, and is committed once it has persisted `confirm_secs`.
/// Returns the new (ath, candidate, candidate_since).
pub fn next_ath(ath: u128, candidate: u128, candidate_since: i64, twap: u128, now: i64, confirm_secs: i64) -> (u128, u128, i64) {
    if twap <= ath {
        return (ath, 0, 0);
    }
    if confirm_secs == 0 {
        return (twap, 0, 0);
    }
    let (cand, since) = if candidate == 0 { (twap, now) } else { (candidate.min(twap), candidate_since) };
    if now - since >= confirm_secs {
        (cand, 0, 0)
    } else {
        (ath, cand, since)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(ts: i64, price: u128) -> Observation {
        Observation { ts, price }
    }

    #[test]
    fn split_is_exact_and_50_25_15_10() {
        assert_eq!(
            split_fees(1_000_000_000),
            FeeSplit { floor: 500_000_000, holder: 250_000_000, creator: 150_000_000, burn: 100_000_000 }
        );
        for amount in [0u64, 1, 7, 9, 10, 11, 999, 1_234_567, u64::MAX] {
            let s = split_fees(amount);
            assert_eq!(s.floor as u128 + s.holder as u128 + s.creator as u128 + s.burn as u128, amount as u128);
            assert_eq!(s.holder as u128, amount as u128 / 4);
            assert_eq!(s.creator as u128, amount as u128 * 15 / 100);
            assert_eq!(s.burn as u128, amount as u128 / 10);
        }
        // rounding dust goes to the floor
        assert_eq!(split_fees(9), FeeSplit { floor: 6, holder: 2, creator: 1, burn: 0 });
    }

    #[test]
    fn floor_tracks_trigger() {
        assert_eq!(floor_from_ath(1_000_000, 2_500), Some(750_000));
        assert_eq!(floor_from_ath(1_000_000, 1_500), Some(850_000));
        assert_eq!(floor_from_ath(1_000_000, 3_500), Some(650_000));
        assert_eq!(floor_from_ath(u128::MAX, 2_500), None);
    }

    #[test]
    fn min_tokens_rounds_up() {
        // 1 SOL at a max price of 2 lamports/base → at least 0.5e9 base units
        assert_eq!(min_tokens_at_price(1_000_000_000, 2 * PRICE_SCALE), Some(500_000_000));
        assert_eq!(min_tokens_at_price(3, 2 * PRICE_SCALE), Some(2));
        assert_eq!(min_tokens_at_price(1, 0), None);
    }

    #[test]
    fn twap_requires_full_coverage() {
        let window = 600;
        // samples every 60s for the last 10 minutes at price 100
        let mut v: Vec<Observation> = (0..=10).map(|i| obs(1_000 + i * 60, 100)).collect();
        v.reverse();
        assert_eq!(twap(v.clone().into_iter(), 1_600, window, 120), Some(100));
        // window not covered yet
        assert_eq!(twap(v.clone().into_iter().take(5), 1_600, window, 120), None);
        // stale newest observation
        assert_eq!(twap(v.clone().into_iter(), 1_900, window, 120), None);
        // gap too large
        let gappy = vec![obs(1_600, 100), obs(1_300, 100), obs(1_000, 100)];
        assert_eq!(twap(gappy.into_iter(), 1_600, window, 120), None);
    }

    #[test]
    fn twap_is_time_weighted() {
        // price 100 from t=0..300, 400 from t=300..600 (now)
        let v = vec![obs(300, 400), obs(0, 100)];
        assert_eq!(twap(v.into_iter(), 600, 600, 300), Some(250));
        // a one-sample spike only moves the TWAP by its duration share
        let v = vec![obs(590, 10_000), obs(0, 100)];
        assert_eq!(twap(v.into_iter(), 600, 600, 600), Some((100 * 590 + 10_000 * 10) / 600));
    }

    #[test]
    fn ath_needs_confirmation() {
        // immediate when confirm = 0
        assert_eq!(next_ath(100, 0, 0, 150, 10, 0), (150, 0, 0));
        // candidate starts
        let (ath, cand, since) = next_ath(100, 0, 0, 150, 10, 300);
        assert_eq!((ath, cand, since), (100, 150, 10));
        // lower TWAP above ATH lowers the candidate
        let (ath, cand, since) = next_ath(ath, cand, since, 130, 200, 300);
        assert_eq!((ath, cand, since), (100, 130, 10));
        // persisted → committed at the lowest level seen
        assert_eq!(next_ath(ath, cand, since, 170, 310, 300), (130, 0, 0));
        // dropping back below resets
        assert_eq!(next_ath(100, 130, 10, 90, 200, 300), (100, 0, 0));
    }
}
