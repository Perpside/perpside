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
