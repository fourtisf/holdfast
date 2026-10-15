# X Article: What is Moatpad and how it works

Header image: `banner.png` (3000 × 1200, 5:2). In the X editor, set the lines marked `##` to **Heading** and `###` to
**Subheading**; the rest pastes as body text.

---

**Title:** What is Moatpad? The launchpad where every coin defends its own floor

---

Most coins launched today have no floor. Moatpad gives every coin one, and pays the people who hold it.

## TL;DR

- Moatpad launches coins on pump.fun with a **floor vault** built in.
- Every trade pays a creator fee. On Moatpad it goes to the **coin's own on-chain vault**, not to a dev wallet.
- **40%** defends the floor · **25%** goes to holders · **15%** to the creator · **10%** to the Moatpad treasury · **10%** buys and burns $MOAT.
- When the price falls to the floor, the vault **buys back on its own**.
- Holders get paid **every 2 minutes**, in SOL and bought-back tokens.
- Floor and holder funds **can never be withdrawn**.
- Launching costs about **0.015 SOL** and one click in your wallet.

## The problem

The usual launch goes like this: the chart runs, the dev sells, liquidity drains, and holders are left with a chart that only goes one way.

Every trade on a launch pays a creator fee, but that money ends up in one wallet. Nothing defends the price, and nothing rewards the people who actually hold.

## What Moatpad is

Moatpad is a launchpad on Solana. Coins launch on pump.fun exactly like any other, with one difference: the coin's creator on pump.fun is **the coin's own vault**, a program address that no person controls.

So the creator fees from every trade, on the pump.fun bonding curve and on PumpSwap after graduation, flow into a vault that works for the coin and its holders.

## How it works

### 1. Launch in one transaction

Fill in a name, a ticker, an image and your socials, pick the floor, and add an optional dev buy. Then confirm **once** in your wallet.

The coin, its vault and your dev buy are created in a **single transaction**, so no sniper can buy between the creation and your dev buy.

It costs about 0.015 SOL (account rent and network fees) plus your dev buy.

### 2. Choose the floor: 15, 25 or 35% below the ATH

The floor is where the vault starts buying back. Tight (15%) defends small dips early; loose (35%) leaves more room. The choice is written into the vault at launch and **can never be changed**.

### 3. Every trade feeds the vault

Each creator fee is split on-chain:

- **40% floor vault:** the buyback reserve.
- **25% holders:** paid out every 2 minutes.
- **15% creator:** claimable on the coin's page, only by the creator wallet.
- **10% Moatpad treasury.**
- **10% buy and burn $MOAT.**

The floor and holder shares stay in the vault. There is no withdraw path for them, not for the creator and not for Moatpad.

### 4. The floor follows the ATH

Floor = ATH × (1 − your trigger). The ATH is time-weighted, so a one-candle wick cannot set it. Every new ATH lifts the floor. It **never moves down**.

### 5. The vault defends the floor

When the price reaches the floor, the vault buys back: **10% of the floor vault per step**, with cooldowns between steps and a cap per hour, so it lasts through a long dip. Anyone can trigger a buyback; it does not depend on us.

The bought-back tokens are **not burned**. They go to the holder pot and are paid out to holders.

### 6. Holders get paid every 2 minutes

Every 2 minutes, the holder pot (SOL + bought-back tokens) is split by **tokens × weight**.

- Your weight grows from **0.1× to 1.0× over 7 days** of holding. Hold longer, earn more.
- Sell part of your bag and the rest keeps its age. Sell everything and you start again at 0.1×.
- Dev buys and tokens received by transfer don't earn.
- A tiny pot waits until paying it is worth the network fees, then it is paid out in one go.

Every round is published with its full snapshot, and its merkle root is committed on-chain, so anyone can verify who was paid and why.

### 7. Creators earn too

Creators get **15% of their coin's fees**, claimable anytime from the coin's page. They have a reason to launch here, and holders get a coin built to be held.

## Why it matters

- **Holders:** a floor that defends itself, and SOL from trading volume paid to your wallet every few minutes. Patience is rewarded.
- **Creators:** 15% of the fees, and a launch people trust.
- **Traders:** the rules are on-chain and visible. The floor, the vault and every buyback (marked "V" on the chart) are right there on the coin page.

## How to launch a coin

1. Go to **moatpad.fun** and click **Create**.
2. Connect your wallet. The creator wallet fills in automatically.
3. Add a name, ticker, image and socials.
4. Choose the floor: 15, 25 or 35%.
5. Add a dev buy if you want one.
6. Click **Launch · confirm in wallet**. Your coin is live on pump.fun with its floor vault.

No wallet in your browser? You can also launch by sending SOL to a one-time deposit address.

## FAQ

**Is the price guaranteed?**
No. The vault defends the floor with what it holds. A buyback slows a fall; it is not a promise of a bottom.

**Can the dev or Moatpad take the vault?**
No. SOL leaves the vault only as buybacks, holder payouts, the creator's 15% claim, the 10% treasury share and the $MOAT buy-and-burn. Floor and holder funds have no withdraw path.

**What happens after graduation?**
The coin moves to PumpSwap. Fees keep flowing into the vault, and buybacks and payouts continue there.

**What does it cost?**
About 0.015 SOL to launch, plus your dev buy. There is no extra Moatpad fee on trades.

## Links

- Website: moatpad.fun
- X: @moatpad
- Telegram: t.me/MOATPAD

Every coin gets a moat. 🏰

*Not financial advice. Memecoins are highly risky; only use what you can afford to lose.*
