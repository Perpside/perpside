// Offline calibration check — no network, no wallet needed.
// Given a target starting FDV and N backing assets with independent USD
// prices, compute per-pool tick ranges + liquidity so all N single-sided
// CLMM positions imply the same starting market cap, and verify each one
// round-trips back to ~the intended COIN amount with ~0 of the backing asset.

import BN from 'bn.js';
import Decimal from 'decimal.js';
import { TickUtil, LiquidityMathUtil } from '@raydium-io/raydium-sdk-v2';

const COIN_DECIMALS = 6;
const TARGET_FDV_USD = 5000; // arbitrary "starting market cap" for this check
const TOTAL_SUPPLY = 1_000_000_000n; // 1e9 whole COIN, matches pump.fun-style supply
const TICK_SPACING = 60; // matches the 0.25%-fee devnet CLMM config fetched earlier

const backingAssets = [
  { symbol: 'XSOL', decimals: 6, usdPrice: new Decimal(150) },
  { symbol: 'XBTC', decimals: 6, usdPrice: new Decimal(60000) },
  { symbol: 'XHYPE', decimals: 6, usdPrice: new Decimal(25) },
];

function splitSupplyEvenly(total, n) {
  const base = total / BigInt(n);
  const remainder = total - base * BigInt(n);
  return Array.from({ length: n }, (_, i) => base + (i === n - 1 ? remainder : 0n));
}

// CLMM requires tickLower/tickUpper to be exact multiples of the pool's
// tick spacing — priceToTick gives the raw nearest tick, not spacing-aligned.
function alignToSpacing(tick, spacing) {
  return Math.round(tick / spacing) * spacing;
}

const shares = splitSupplyEvenly(TOTAL_SUPPLY, backingAssets.length);
console.log('Supply split:', shares.map(String), 'sum =', shares.reduce((a, b) => a + b, 0n).toString());
console.log('---');

for (let i = 0; i < backingAssets.length; i++) {
  const asset = backingAssets[i];
  const coinShare = shares[i]; // whole COIN units for this pool

  // Price of 1 COIN in units of this backing asset, for the same target FDV.
  const coinPriceInAsset = new Decimal(TARGET_FDV_USD)
    .div(TOTAL_SUPPLY.toString())
    .div(asset.usdPrice);

  const rawStartTick = TickUtil.priceToTick(coinPriceInAsset, COIN_DECIMALS, asset.decimals);
  const tickLower = alignToSpacing(rawStartTick, TICK_SPACING);
  const snappedStartPrice = TickUtil.tickToPrice(tickLower, COIN_DECIMALS, asset.decimals);

  // Ceiling of the single-sided range: arbitrary 20x above start for this
  // check (this is the "how far up before the position runs dry" choice —
  // a real launch would size this deliberately, not just 20x).
  const ceilingPrice = snappedStartPrice.mul(20);
  const rawCeilingTick = TickUtil.priceToTick(ceilingPrice, COIN_DECIMALS, asset.decimals);
  const tickUpper = alignToSpacing(rawCeilingTick, TICK_SPACING);

  const sqrtPriceLowerX64 = TickUtil.getSqrtPriceAtTick(tickLower);
  const sqrtPriceUpperX64 = TickUtil.getSqrtPriceAtTick(tickUpper);

  // Raw atomic units of COIN going into this position.
  const coinAmountAtomic = new BN((coinShare * 10n ** BigInt(COIN_DECIMALS)).toString());

  // Single-sided (100% COIN = mintA) => solve for L from amountA alone.
  const liquidity = LiquidityMathUtil.getLiquidityFromAmountA(
    sqrtPriceLowerX64,
    sqrtPriceUpperX64,
    coinAmountAtomic
  );

  // Round-trip check: current price = tickLower (position starts entirely
  // out of range, single-sided), so amountsForLiquidity at the *lower*
  // sqrt price should return ~coinAmountAtomic for A and ~0 for B.
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(
    sqrtPriceLowerX64, // "current" price = the position's own lower bound
    sqrtPriceLowerX64,
    sqrtPriceUpperX64,
    liquidity,
    false
  );

  const dustCoin = coinAmountAtomic.sub(amountA);
  const impliedFdvCheck = new Decimal(TOTAL_SUPPLY.toString())
    .mul(snappedStartPrice)
    .mul(asset.usdPrice);

  console.log(`[${asset.symbol}] usdPrice=${asset.usdPrice}`);
  console.log('  start price (asset/COIN):', snappedStartPrice.toString());
  console.log('  tickLower/tickUpper:', tickLower, '/', tickUpper);
  console.log('  liquidity L:', liquidity.toString());
  console.log('  amountA (COIN) requested vs derived:', coinAmountAtomic.toString(), 'vs', amountA.toString(), '(dust:', dustCoin.toString(), 'atomic units)');
  console.log('  amountB (asset) — should be ~0 for single-sided:', amountB.toString());
  console.log('  implied starting FDV via this pool: $', impliedFdvCheck.toFixed(2), ' (target was $' + TARGET_FDV_USD + ')');
  console.log('---');
}
