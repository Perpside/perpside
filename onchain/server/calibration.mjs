import { TickUtil, LiquidityMathUtil } from '@raydium-io/raydium-sdk-v2';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';

export function alignToSpacing(tick, spacing) {
  return Math.round(tick / spacing) * spacing;
}

// Split total supply into N whole-token shares, remainder folded into the
// last one. See docs/token-launch-plan.md "Splitting supply across N pools".
export function splitSupplyEvenly(total, n) {
  const base = total / BigInt(n);
  const remainder = total - base * BigInt(n);
  return Array.from({ length: n }, (_, i) => base + (i === n - 1 ? remainder : 0n));
}

// Raydium/Uniswap-v3-fork convention: mintA is whichever pubkey sorts lower
// as raw bytes. Must be decided *before* calling createPool — the pool's
// price is fixed at creation, so guessing wrong here can't be fixed after.
export function isCoinMintA(coinMint, assetMint) {
  return Buffer.compare(new PublicKey(coinMint).toBuffer(), new PublicKey(assetMint).toBuffer()) < 0;
}

// Given a known coin/asset mintA-vs-mintB order, compute a calibrated
// single-sided tick range (100% COIN) that implies targetFdvUsd, and the
// liquidity for depositing coinShare atomic units of COIN.
export function calibratePool({
  coinIsMintA,
  coinDecimals,
  assetDecimals,
  assetUsdPrice,
  targetFdvUsd,
  totalSupplyWhole,
  coinShareAtomic,
  tickSpacing,
  ceilingMultiplier = 20,
}) {
  const coinPriceInAsset = new Decimal(targetFdvUsd)
    .div(totalSupplyWhole.toString())
    .div(assetUsdPrice);

  const decA = coinIsMintA ? coinDecimals : assetDecimals;
  const decB = coinIsMintA ? assetDecimals : coinDecimals;
  // CLMM price is always "amount of B per 1 A".
  const priceForTick = coinIsMintA ? coinPriceInAsset : new Decimal(1).div(coinPriceInAsset);

  const rawAnchorTick = TickUtil.priceToTick(priceForTick, decA, decB);
  const anchorTick = alignToSpacing(rawAnchorTick, tickSpacing);
  const anchorPrice = TickUtil.tickToPrice(anchorTick, decA, decB);

  // If COIN=A, the position must sit *above* current price (price ≤ tickLower)
  // to be 100% A. If COIN=B, it must sit *below* current price (price ≥
  // tickUpper) to be 100% B. Either way, anchorTick is the edge touching the
  // starting price, and the other edge is ceilingMultiplier further from it
  // in the direction that keeps the position single-sided.
  const otherEndPrice = coinIsMintA ? anchorPrice.mul(ceilingMultiplier) : anchorPrice.div(ceilingMultiplier);
  const rawOtherEndTick = TickUtil.priceToTick(otherEndPrice, decA, decB);
  const otherEndTick = alignToSpacing(rawOtherEndTick, tickSpacing);

  const tickLower = Math.min(anchorTick, otherEndTick);
  const tickUpper = Math.max(anchorTick, otherEndTick);

  const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLower);
  const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpper);

  // Pool's starting price must sit exactly on the edge the position touches,
  // so the position is single-sided from block zero: tickLower if COIN=A
  // (price starts at/below the range), tickUpper if COIN=B (price starts
  // at/above the range). `createCustomizablePool` only takes a decimal
  // price, not a raw sqrtPriceX64 — it re-derives its own sqrtPriceX64 from
  // that decimal internally, and the round-trip loses just enough precision
  // to floor to one tick below whichever boundary we pass in. Harmless for
  // COIN=A (rounding down only pushes the start further outside the range,
  // which is what single-sided-A already wants) but wrong for COIN=B (it
  // needs the start to land *at or above* tickUpper, and landing one tick
  // short puts it inside the range instead — a dust amount of the backing
  // asset ends up live in the position instead of 0). Confirmed on real
  // launched pools: COIN-as-mintB pools decoded with non-zero liquidity at
  // tickCurrent = tickUpper - 1, while COIN-as-mintA pools correctly showed
  // 0. Fixed by resolving against the exact same decimal round-trip
  // `createCustomizablePool` performs (not assumed), nudging outward by a
  // tick until it verifiably lands on the correct side.
  function resolveBoundaryStartPrice(boundaryTick, wantTickAtLeast) {
    let tick = boundaryTick;
    for (let attempt = 0; attempt < 5; attempt++) {
      const price = TickUtil.tickToPrice(tick, decA, decB);
      const roundTrippedSqrtPrice = TickUtil.priceToSqrtPriceX64(price, decA, decB);
      const resolvedTick = TickUtil.getTickAtSqrtPrice(roundTrippedSqrtPrice);
      const onCorrectSide = wantTickAtLeast ? resolvedTick >= boundaryTick : resolvedTick < boundaryTick;
      if (onCorrectSide) return price;
      tick += wantTickAtLeast ? 1 : -1;
    }
    throw new Error('could not resolve a single-sided starting price for tick ' + boundaryTick);
  }

  const base = coinIsMintA ? 'MintA' : 'MintB';
  const startPrice = coinIsMintA
    ? resolveBoundaryStartPrice(tickLower, false)
    : resolveBoundaryStartPrice(tickUpper, true);

  const liquidity = coinIsMintA
    ? LiquidityMathUtil.getLiquidityFromAmountA(sqrtPriceLowerX64, sqrtPriceUpperX64, coinShareAtomic)
    : LiquidityMathUtil.getLiquidityFromAmountB(sqrtPriceLowerX64, sqrtPriceUpperX64, coinShareAtomic);

  return { tickLower, tickUpper, base, startPrice, liquidity };
}

export function toAtomicUnits(wholeAmount, decimals) {
  return new BN((wholeAmount * 10n ** BigInt(decimals)).toString());
}

// pump.fun's own real (non-virtual) bonding-curve constants — replicated
// here not because the number is special, but because it's the
// recognizable, battle-tested "how a launch is supposed to feel" reference
// point: 79.31% of supply committed to the pre-market position, the rest
// held back for the three real pools at graduation, and priced off the
// same starting ratio (30 "virtual" SOL against 1.073B "virtual" tokens)
// pump.fun's own curve starts at. Confirmed against pump-fun-sdk's own
// bonding-curve-math.md (INITIAL_REAL_TOKEN_RESERVES = 793,100,000 whole
// tokens at 6 decimals) rather than assumed from memory.
export const PREMARKET_CURVE_COIN_WHOLE = 793_100_000n;
export const PREMARKET_TARGET_RAISE_SOL = 85;
const PREMARKET_VIRTUAL_SOL = 30;
const PREMARKET_VIRTUAL_COIN = 1_073_000_000;

// Finds the single-sided COIN/SOL position that starts at pump.fun's own
// implied price and, once fully swept (all PREMARKET_CURVE_COIN_WHOLE sold),
// yields as close to PREMARKET_TARGET_RAISE_SOL as tick alignment allows.
//
// Unlike calibratePool's ceilingMultiplier (an arbitrary, independently-
// chosen range width), here the range width is *solved for* — the amount
// of SOL a fully-depleted range yields is a function of both its width and
// the deposited COIN amount, and both those are now fixed (the curve's
// COIN allocation, and the target raise), so there's exactly one range
// width that hits it. Solved numerically via bisection against the SDK's
// own liquidity/delta-amount functions — not a hand-derived closed form —
// specifically so any mistake shows up as "didn't converge," not as a
// silently wrong pool.
export function calibratePreMarketPool({ coinIsMintA, coinDecimals, solDecimals, tickSpacing }) {
  const decA = coinIsMintA ? coinDecimals : solDecimals;
  const decB = coinIsMintA ? solDecimals : coinDecimals;

  const coinPriceInSol = new Decimal(PREMARKET_VIRTUAL_SOL).div(PREMARKET_VIRTUAL_COIN);
  const priceForTick = coinIsMintA ? coinPriceInSol : new Decimal(1).div(coinPriceInSol);

  const rawAnchorTick = TickUtil.priceToTick(priceForTick, decA, decB);
  const anchorTick = alignToSpacing(rawAnchorTick, tickSpacing);
  const sqrtAnchor = TickUtil.getSqrtPriceAtTick(anchorTick);

  const coinShareAtomic = toAtomicUnits(PREMARKET_CURVE_COIN_WHOLE, coinDecimals);
  const targetLamports = new BN(PREMARKET_TARGET_RAISE_SOL).mul(new BN(10).pow(new BN(solDecimals)));

  function solAtDepletion(candidateTick) {
    const sqrtCandidate = TickUtil.getSqrtPriceAtTick(candidateTick);
    const [sqrtLower, sqrtUpper] = coinIsMintA ? [sqrtAnchor, sqrtCandidate] : [sqrtCandidate, sqrtAnchor];
    const liquidity = coinIsMintA
      ? LiquidityMathUtil.getLiquidityFromAmountA(sqrtLower, sqrtUpper, coinShareAtomic)
      : LiquidityMathUtil.getLiquidityFromAmountB(sqrtLower, sqrtUpper, coinShareAtomic);
    // Full depletion always converts the position entirely into the token
    // that *wasn't* deposited — the delta-amount formula for that other
    // token, regardless of which side started single-sided.
    return coinIsMintA
      ? LiquidityMathUtil.getDeltaAmountBUnsigned(sqrtLower, sqrtUpper, liquidity, false)
      : LiquidityMathUtil.getDeltaAmountAUnsigned(sqrtLower, sqrtUpper, liquidity, false);
  }

  // narrow/wide rather than lo/hi: solAtDepletion increases monotonically
  // moving *away* from anchorTick regardless of which direction that is
  // for this orientation, so tracking "zero-width" vs "wide" bounds
  // directly avoids needing a sign flip per orientation.
  let narrow = anchorTick;
  let wide = coinIsMintA ? Math.min(anchorTick + 400_000, 443_635) : Math.max(anchorTick - 400_000, -443_635);
  for (let i = 0; i < 60; i++) {
    const mid = Math.round((narrow + wide) / 2);
    if (mid === narrow || mid === wide) break;
    const got = solAtDepletion(mid);
    if (got.lt(targetLamports)) narrow = mid; else wide = mid;
  }
  const ceilingTick = alignToSpacing(wide, tickSpacing);

  const tickLower = Math.min(anchorTick, ceilingTick);
  const tickUpper = Math.max(anchorTick, ceilingTick);
  const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLower);
  const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpper);

  // Same createCustomizablePool decimal round-trip issue calibratePool
  // already works around (see its own resolveBoundaryStartPrice comment)
  // — reused verbatim rather than re-derived, since it's the exact same
  // underlying SDK behavior regardless of which calibration produced the
  // tick range.
  function resolveBoundaryStartPrice(boundaryTick, wantTickAtLeast) {
    let tick = boundaryTick;
    for (let attempt = 0; attempt < 5; attempt++) {
      const price = TickUtil.tickToPrice(tick, decA, decB);
      const roundTrippedSqrtPrice = TickUtil.priceToSqrtPriceX64(price, decA, decB);
      const resolvedTick = TickUtil.getTickAtSqrtPrice(roundTrippedSqrtPrice);
      const onCorrectSide = wantTickAtLeast ? resolvedTick >= boundaryTick : resolvedTick < boundaryTick;
      if (onCorrectSide) return price;
      tick += wantTickAtLeast ? 1 : -1;
    }
    throw new Error('could not resolve a single-sided starting price for tick ' + boundaryTick);
  }

  const base = coinIsMintA ? 'MintA' : 'MintB';
  const startPrice = coinIsMintA
    ? resolveBoundaryStartPrice(tickLower, false)
    : resolveBoundaryStartPrice(tickUpper, true);

  const liquidity = coinIsMintA
    ? LiquidityMathUtil.getLiquidityFromAmountA(sqrtPriceLowerX64, sqrtPriceUpperX64, coinShareAtomic)
    : LiquidityMathUtil.getLiquidityFromAmountB(sqrtPriceLowerX64, sqrtPriceUpperX64, coinShareAtomic);

  return { tickLower, tickUpper, base, startPrice, liquidity, coinShareAtomic };
}
