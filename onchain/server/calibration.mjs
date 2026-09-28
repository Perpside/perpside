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
  // at/above the range).
  const base = coinIsMintA ? 'MintA' : 'MintB';
  const startSqrtPriceX64 = coinIsMintA ? sqrtPriceLowerX64 : sqrtPriceUpperX64;
  const startPrice = TickUtil.sqrtPriceX64ToPrice(startSqrtPriceX64, decA, decB);

  const liquidity = coinIsMintA
    ? LiquidityMathUtil.getLiquidityFromAmountA(sqrtPriceLowerX64, sqrtPriceUpperX64, coinShareAtomic)
    : LiquidityMathUtil.getLiquidityFromAmountB(sqrtPriceLowerX64, sqrtPriceUpperX64, coinShareAtomic);

  return { tickLower, tickUpper, base, startPrice, liquidity };
}

export function toAtomicUnits(wholeAmount, decimals) {
  return new BN((wholeAmount * 10n ** BigInt(decimals)).toString());
}
