use anchor_lang::prelude::*;

#[error_code]
pub enum HoldfastError {
    #[msg("trigger must be 1500, 2500 or 3500 bps")]
    InvalidTrigger,
    #[msg("parameter out of allowed range")]
    InvalidParams,
    #[msg("hold mint is already set")]
    HoldMintAlreadySet,
    #[msg("hold mint is not set")]
    HoldMintNotSet,
    #[msg("program is paused")]
    Paused,
    #[msg("bonding curve creator is not this coin's treasury")]
    CreatorMismatch,
    #[msg("only SOL-quoted coins are supported")]
    UnsupportedQuote,
    #[msg("bonding curve already complete")]
    CurveComplete,
    #[msg("bonding curve not complete yet")]
    CurveNotComplete,
    #[msg("account does not belong to the expected program")]
    InvalidOwner,
    #[msg("account data does not match the expected layout")]
    InvalidAccountData,
    #[msg("price account does not match the coin's venue")]
    WrongPriceAccount,
    #[msg("pool is not the canonical PumpSwap pool for this mint")]
    NotCanonicalPool,
    #[msg("wrong venue for this operation")]
    WrongVenue,
    #[msg("venue instruction accounts are invalid")]
    InvalidVenueAccounts,
    #[msg("price observation too soon after the previous one")]
    ObservationTooSoon,
    #[msg("no floor yet: ATH has not been established")]
    NoFloor,
    #[msg("price is above the floor")]
    PriceAboveFloor,
    #[msg("defend cooldown has not elapsed")]
    DefendCooldown,
    #[msg("hourly defend limit reached")]
    DefendHourlyLimit,
    #[msg("floor vault too small to defend")]
    FloorVaultTooSmall,
    #[msg("swap returned fewer tokens than required")]
    SlippageExceeded,
    #[msg("swap spent more SOL than allowed")]
    OverspentSwap,
    #[msg("burn bucket too small")]
    BurnBucketTooSmall,
    #[msg("a payout round is already open")]
    RoundAlreadyOpen,
    #[msg("no matching open round")]
    RoundNotOpen,
    #[msg("round id must be the next one")]
    InvalidRoundId,
    #[msg("too soon since the previous round")]
    RoundTooSoon,
    #[msg("round pot exceeds the holder bucket")]
    PotExceedsBucket,
    #[msg("invalid recipient count")]
    InvalidRecipientCount,
    #[msg("payout exceeds the round pot")]
    PotExceeded,
    #[msg("recipient index out of range")]
    RecipientIndexOutOfRange,
    #[msg("recipient already paid this round")]
    AlreadyPaid,
    #[msg("recipient is not a regular wallet")]
    NotAWallet,
    #[msg("recipient token account invalid")]
    InvalidRecipientTokenAccount,
    #[msg("payout would leave the recipient below the rent-exempt minimum")]
    RecipientBelowRent,
    #[msg("payout entry is empty")]
    EmptyEntry,
    #[msg("remaining accounts do not match payout entries")]
    RemainingAccountsMismatch,
    #[msg("vault accounting invariant violated")]
    InvariantViolation,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("only the pending admin can accept")]
    NotPendingAdmin,
    #[msg("treasury account missing: run prepare_treasury first")]
    TreasuryAccountMissing,
    #[msg("wrong pump volume accumulator accounts")]
    InvalidVolumeAccounts,
    #[msg("creator must be a wallet, not one of the coin's program accounts")]
    InvalidCreator,
    #[msg("no creator fees to claim")]
    NothingToClaim,
    #[msg("platform treasury is not set")]
    PlatformTreasuryNotSet,
    #[msg("no platform fees to sweep")]
    NothingToSweep,
}
