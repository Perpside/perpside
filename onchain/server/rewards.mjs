import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  getConnection,
  getPlatformWallet,
  getPoolPendingFees,
  harvestPoolFees,
  sendTokenBatch,
  swapPlatformAssetForCoin,
  burnCoin,
  CLUSTER,
} from './solana.mjs';
import { listBackingAssets } from './launch.mjs';
import {
  listCompleteTokens,
  getIncompleteRewardRun,
  createRewardRun,
  updateRewardRunStatus,
  getRewardRunPools,
  insertRewardRunPool,
  markRewardRunPoolHarvested,
  updateRewardRunPoolStatus,
  insertRewardPayout,
  getRewardPayouts,
  markRewardPayoutSent,
  markRewardBuybackSent,
} from './db.mjs';

// A token's *combined* pending fees (summed in USD across all its pools)
// need to cross this before a reward run triggers — low enough that real
// launches eventually pay out, high enough that a harvest+distribute run
// (several transactions, each costing real SOL in fees/rent) isn't spent
// chasing a trickle. See docs/token-launch-plan.md for the reasoning.
const TRIGGER_THRESHOLD_USD = 5000;

// Below this, a holder's share costs more to deliver (ATA rent + tx fee,
// ~0.002 SOL) than it's worth — skipped rather than spent chasing dust.
// The skipped amount stays in the platform's wallet (see insertRewardPayout
// calls below with status 'skipped_dust') rather than pretending it's still
// sitting in the pool — harvesting is all-or-nothing per position, so once
// harvested there's no partial-position amount left to reharvest later.
const DUST_THRESHOLD_USD = 1;

// Platform revenue cut — taken off the top of every harvest, before the
// Community/Creator/Buyback split even runs. Community/Creator/Buyback
// percentages the creator configured at launch describe the *pool's* fee,
// not this cut, so this comes first and the reward-model split runs on
// whatever's left, not on the full harvested amount.
const PLATFORM_FEE_FRACTION = 0.10;
const REVENUE_WALLET = '7qRCnebUspWNLEFbmgcvWrrJq28gHV8CjdqPfshpZxfj';

const backingAssets = listBackingAssets();

function backingAssetInfo(symbol) {
  const asset = backingAssets[symbol];
  if (!asset) throw new Error(`unknown backing asset: ${symbol}`);
  return asset;
}

// Devnet's stand-in assets have no real market (same reasoning as
// launch.mjs resolveAssetUsdPrice) — mainnet fetches a live price and
// simply skips this token's check for the current cron tick on failure
// (returns null) rather than throwing, since there's always a next tick.
async function fetchAssetUsdPrice(asset) {
  if (CLUSTER !== 'mainnet-beta') return asset.usdPrice;
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${asset.mint}`);
    if (!res.ok) return null;
    const [token] = await res.json();
    return token && typeof token.usdPrice === 'number' ? token.usdPrice : null;
  } catch {
    return null;
  }
}

function atomicToWhole(amountAtomic, decimals) {
  return Number(amountAtomic.toString()) / 10 ** decimals;
}

// Sums a token's pending (unharvested) fees across all its pools, in USD —
// cheap to check every cron tick since it reads on-chain state directly
// (see solana.mjs getPoolPendingFees) rather than spending a transaction.
// Returns null if any pool's price can't be resolved right now, so the
// caller skips this token for the tick instead of triggering on a partial
// total.
async function computeTokenPendingFeesUsd(token) {
  let totalUsd = 0;
  for (const pool of token.pools) {
    const asset = backingAssetInfo(pool.backing_asset);
    const usdPrice = await fetchAssetUsdPrice(asset);
    if (usdPrice == null) return null;
    const pendingAtomic = await getPoolPendingFees(
      { poolAddress: pool.pool_address, positionNftMint: pool.position_nft_mint, tickLower: pool.tick_lower, tickUpper: pool.tick_upper },
      token.mint_address
    );
    totalUsd += atomicToWhole(pendingAtomic, asset.decimals) * usdPrice;
  }
  return totalUsd;
}

// Every token account for `mint` whose owner isn't one of this token's own
// pool vaults or the platform wallet — i.e. accounts that represent an
// actual person holding COIN, not the platform's own infrastructure. Pool
// vaults show up as the *largest* holders (they hold the single-sided
// launch liquidity), so leaving them in would send the community pot
// straight back into the pools that generated it.
async function getRealHolders(mint, excludeOwners) {
  const connection = getConnection();
  const accounts = await connection.getParsedProgramAccounts(
    new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    { filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }] }
  );
  const excluded = new Set(excludeOwners);
  return accounts
    .map((a) => ({ wallet: a.account.data.parsed.info.owner, balanceAtomic: new BN(a.account.data.parsed.info.tokenAmount.amount) }))
    .filter((h) => !excluded.has(h.wallet) && h.balanceAtomic.gtn(0));
}

// Splits a harvested pool's fees into community/creator/buyback amounts
// using the ratio between the token's stored percentages — those were
// constructed at launch time (see index.html's reward-model sliders) to
// always sum to the pool's actual on-chain trade fee, so this recovers each
// destination's *share of that fee*, not an absolute percentage of
// anything. Scaled-integer math (not float) to keep the split exact.
function splitByRewardModel(harvestedAtomic, token) {
  const scale = 1_000_000;
  const community = Math.round((token.community_fee || 0) * scale);
  const creator = Math.round((token.creator_fee || 0) * scale);
  const buyback = Math.round((token.buyback_fee || 0) * scale);
  const total = community + creator + buyback;
  if (total <= 0) return { communityAtomic: new BN(0), creatorAtomic: new BN(0), buybackAtomic: harvestedAtomic };

  const communityAtomic = harvestedAtomic.mul(new BN(community)).div(new BN(total));
  const creatorAtomic = harvestedAtomic.mul(new BN(creator)).div(new BN(total));
  // Buyback takes the remainder rather than its own ratio'd slice, so
  // integer division truncation can't leave a few atomic units stranded
  // unaccounted-for.
  const buybackAtomic = harvestedAtomic.sub(communityAtomic).sub(creatorAtomic);
  return { communityAtomic, creatorAtomic, buybackAtomic };
}

// Each of the three payout functions below is safe to call again after a
// partial failure: the *first* call for a given runPoolId computes and
// persists the intended payout(s) as 'pending' rows before sending
// anything; every call after that only re-reads what's already persisted
// and resumes whatever's still 'pending', rather than recomputing shares
// (holder balances can shift between attempts) or re-inserting rows (which
// would double-pay whatever already landed on an earlier, partially
// successful attempt). This is what lets a whole pool retry safely after
// one of its three payout kinds fails without redoing the other two.

async function distributeCommunity({ runPoolId, mintAddress, backingAssetMint, decimals, usdPrice, amountAtomic, excludeOwners }) {
  let payouts = getRewardPayouts(runPoolId).filter((p) => p.kind === 'community');
  if (!payouts.length) {
    if (amountAtomic.lten(0)) return;
    const holders = await getRealHolders(mintAddress, excludeOwners);
    const totalHeld = holders.reduce((s, h) => s.add(h.balanceAtomic), new BN(0));
    if (totalHeld.lten(0) || !holders.length) return;

    const dustAtomicFloor = usdPrice > 0 ? new BN(Math.ceil((DUST_THRESHOLD_USD / usdPrice) * 10 ** decimals)) : new BN(0);
    for (const holder of holders) {
      const share = amountAtomic.mul(holder.balanceAtomic).div(totalHeld);
      const status = share.gte(dustAtomicFloor) ? 'pending' : 'skipped_dust';
      insertRewardPayout({ runPoolId, kind: 'community', recipientWallet: holder.wallet, amount: share, status });
    }
    payouts = getRewardPayouts(runPoolId).filter((p) => p.kind === 'community');
  }

  const toSend = payouts.filter((p) => p.status === 'pending').map((p) => ({ wallet: p.recipient_wallet, amountAtomic: new BN(p.amount) }));
  if (!toSend.length) return;

  const results = await sendTokenBatch(backingAssetMint, toSend);
  for (const result of results) {
    const payout = payouts.find((p) => p.recipient_wallet === result.wallet && p.status === 'pending');
    if (payout) markRewardPayoutSent(payout.id, result.txId);
  }
}

async function payCreator({ runPoolId, backingAssetMint, creatorWallet, amountAtomic }) {
  let payout = getRewardPayouts(runPoolId).find((p) => p.kind === 'creator');
  if (!payout) {
    if (amountAtomic.lten(0) || !creatorWallet) return;
    const id = insertRewardPayout({ runPoolId, kind: 'creator', recipientWallet: creatorWallet, amount: amountAtomic, status: 'pending' });
    payout = getRewardPayouts(runPoolId).find((p) => p.id === id);
  }
  if (payout.status !== 'pending') return;

  const [result] = await sendTokenBatch(backingAssetMint, [{ wallet: payout.recipient_wallet, amountAtomic: new BN(payout.amount) }]);
  markRewardPayoutSent(payout.id, result.txId);
}

async function executeBuyback({ runPoolId, poolAddress, coinMint, backingAssetMint, amountAtomic }) {
  let payout = getRewardPayouts(runPoolId).find((p) => p.kind === 'buyback');
  if (!payout) {
    if (amountAtomic.lten(0)) return;
    const id = insertRewardPayout({ runPoolId, kind: 'buyback', recipientWallet: null, amount: amountAtomic, status: 'pending' });
    payout = getRewardPayouts(runPoolId).find((p) => p.id === id);
  }
  if (payout.status !== 'pending') return;

  const swapResult = await swapPlatformAssetForCoin({ poolId: poolAddress, coinMint, assetMint: backingAssetMint, amountIn: new BN(payout.amount) });
  const burnResult = await burnCoin(coinMint, swapResult.coinAmountOut);
  markRewardBuybackSent(payout.id, `${swapResult.txId},${burnResult.txId}`, swapResult.coinAmountOut);
}

async function payPlatformRevenue({ runPoolId, backingAssetMint, amountAtomic }) {
  let payout = getRewardPayouts(runPoolId).find((p) => p.kind === 'platform');
  if (!payout) {
    if (amountAtomic.lten(0)) return;
    const id = insertRewardPayout({ runPoolId, kind: 'platform', recipientWallet: REVENUE_WALLET, amount: amountAtomic, status: 'pending' });
    payout = getRewardPayouts(runPoolId).find((p) => p.id === id);
  }
  if (payout.status !== 'pending') return;

  const [result] = await sendTokenBatch(backingAssetMint, [{ wallet: payout.recipient_wallet, amountAtomic: new BN(payout.amount) }]);
  markRewardPayoutSent(payout.id, result.txId);
}

async function processPool(run, token, pool) {
  const asset = backingAssetInfo(pool.backing_asset);
  let runPool = getRewardRunPools(run.id).find((rp) => rp.pool_id === pool.id);
  if (!runPool) {
    const id = insertRewardRunPool({ runId: run.id, poolId: pool.id, backingAsset: pool.backing_asset, backingAssetMint: pool.backing_asset_mint });
    runPool = { id, status: 'pending', harvested_amount: null };
  }
  if (runPool.status === 'distributed') return; // nothing left to do

  // Whether the harvest already happened is tracked by harvested_amount
  // being set, not by the status string — a pool can be marked 'failed'
  // *after* a successful harvest (e.g. the distribute step failed), and
  // retrying it must not harvest a second time.
  if (runPool.harvested_amount == null) {
    try {
      const harvest = await harvestPoolFees(
        { poolAddress: pool.pool_address, lockNftMint: pool.lock_nft_mint },
        pool.backing_asset_mint
      );
      markRewardRunPoolHarvested(runPool.id, harvest.harvestedAtomic, harvest.txId);
      runPool.harvested_amount = harvest.harvestedAtomic.toString();
    } catch (err) {
      updateRewardRunPoolStatus(runPool.id, 'failed', err.message);
      return;
    }
  }

  try {
    const harvestedAtomic = new BN(runPool.harvested_amount);
    const platformFeeAtomic = harvestedAtomic.muln(Math.round(PLATFORM_FEE_FRACTION * 100)).divn(100);
    await payPlatformRevenue({ runPoolId: runPool.id, backingAssetMint: pool.backing_asset_mint, amountAtomic: platformFeeAtomic });

    const remainderAtomic = harvestedAtomic.sub(platformFeeAtomic);
    const { communityAtomic, creatorAtomic, buybackAtomic } = splitByRewardModel(remainderAtomic, token);
    const usdPrice = (await fetchAssetUsdPrice(asset)) ?? 0;
    const excludeOwners = [...token.pools.map((p) => p.pool_address), getPlatformWallet().publicKey.toBase58()];

    await distributeCommunity({
      runPoolId: runPool.id, mintAddress: token.mint_address, backingAssetMint: pool.backing_asset_mint,
      decimals: asset.decimals, usdPrice, amountAtomic: communityAtomic, excludeOwners,
    });
    await payCreator({ runPoolId: runPool.id, backingAssetMint: pool.backing_asset_mint, creatorWallet: token.creator_wallet, amountAtomic: creatorAtomic });
    await executeBuyback({ runPoolId: runPool.id, poolAddress: pool.pool_address, coinMint: token.mint_address, backingAssetMint: pool.backing_asset_mint, amountAtomic: buybackAtomic });

    updateRewardRunPoolStatus(runPool.id, 'distributed');
  } catch (err) {
    updateRewardRunPoolStatus(runPool.id, 'failed', err.message);
  }
}

async function processToken(token) {
  // 'failed' is included so a run stuck on a transient error (a dropped
  // RPC call, a momentary price-fetch failure) gets retried on the next
  // tick instead of leaving its funds stranded mid-distribution forever —
  // safe because every payout step above is itself idempotent per kind.
  let run = getIncompleteRewardRun(token.mint_address);
  if (!run) {
    const pendingUsd = await computeTokenPendingFeesUsd(token);
    if (pendingUsd == null || pendingUsd < TRIGGER_THRESHOLD_USD) return;
    const id = createRewardRun(token.mint_address);
    run = { id, mint_address: token.mint_address, status: 'harvesting' };
  }

  for (const pool of token.pools) {
    await processPool(run, token, pool);
  }

  const runPools = getRewardRunPools(run.id);
  const allSettled = runPools.length === token.pools.length && runPools.every((rp) => rp.status === 'distributed' || rp.status === 'failed');
  if (allSettled) {
    const anyFailed = runPools.some((rp) => rp.status === 'failed');
    updateRewardRunStatus(run.id, anyFailed ? 'failed' : 'complete', anyFailed ? 'one or more pools failed — see reward_run_pools' : null);
  }
}

// Entry point for the cron script (reward-cron.mjs) — checks every
// complete launch's accrued fees, triggers/resumes reward runs as needed.
// Tokens are processed sequentially, not in parallel: each run makes
// several real transactions against the platform's own wallet/nonce, and
// there's no benefit worth the added complexity of racing them.
export async function runRewardCycle() {
  const tokens = listCompleteTokens();
  for (const token of tokens) {
    try {
      await processToken(token);
    } catch (err) {
      console.error(`reward cycle failed for ${token.mint_address}:`, err.message);
    }
  }
}
