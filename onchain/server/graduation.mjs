// Orchestrates graduation end to end: detects a fully-depleted pre-market
// position (see solana.mjs isPreMarketPoolDepleted), closes it, splits the
// recovered SOL/COIN across the launch's backing assets, swaps each SOL
// share, and seeds + locks one CPMM pool per asset. Mirrors rewards.mjs's
// layering (solana.mjs holds single on-chain operations, this file composes
// them) *and* its resumability pattern (graduation_runs/graduation_run_assets
// mirror reward_runs/reward_run_pools) — graduation is several sequential
// on-chain steps, so a crash mid-run resumes from whatever's already
// persisted instead of retrying a step that already landed.
import { randomUUID } from 'crypto';
import BN from 'bn.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { closePreMarketPool, swapPlatformSolForAsset, createCpmmPoolAndLock, isPreMarketPoolDepleted, graduationReserveLamports } from './solana.mjs';
import {
  listPremarketTokens,
  listGraduatingTokens,
  getPremarketToken,
  getIncompleteGraduationRun,
  createGraduationRun,
  markGraduationRunClosed,
  updateGraduationRunStatus,
  getGraduationRunAssets,
  insertGraduationRunAsset,
  markGraduationRunAssetSwapped,
  markGraduationRunAssetPoolCreated,
  updateGraduationRunAssetStatus,
  insertFinalPool,
  updatePremarketPoolStatus,
  markPremarketPoolClosed,
  updateTokenStatus,
} from './db.mjs';

// "Split total, remainder folded into the last share" — over a BN, since
// atomic lamport/token amounts flow through solana.mjs as BN, not BigInt.
function splitAtomicEvenly(total, n) {
  const base = total.divn(n);
  const remainder = total.sub(base.muln(n));
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? base.add(remainder) : base));
}

// Drives one backing asset's share from wherever it left off. Resumption is
// keyed off what's actually persisted (swap_tx, then pool_id) rather than
// the row's `status` field — same "trust the real state, not a label"
// approach the rest of this session has used throughout — so a row that
// failed after swapping doesn't re-swap on retry, and one that failed before
// swapping does.
async function processAsset(token, row, totalRewardFeePercent) {
  if (row.status === 'pool_created') return;
  try {
    // From token.backingAssets (resolved on-chain at launch time, see
    // launch.mjs assertAssets) rather than re-fetched here — any real mint
    // now, not just the three Hylo registry ones that could assume 6.
    const assetInfo = (token.backingAssets || []).find((a) => a.mint === row.backing_asset_mint);
    if (!assetInfo) throw new Error(`no decimals on record for backing asset ${row.backing_asset_mint} — missing from token.backingAssets`);
    // Tokens launched before Token-2022 support existed have no programId
    // on their stored backingAssets row — but assertAssets back then only
    // ever accepted classic SPL mints (getMintDecimals rejected Token-2022
    // outright), so classic SPL is the only thing a missing value can mean.
    const assetProgramId = assetInfo.programId || TOKEN_PROGRAM_ID.toBase58();

    let swapTx = row.swap_tx;
    let assetAmountAtomic = row.asset_amount_atomic ? new BN(row.asset_amount_atomic) : null;
    if (!swapTx) {
      // createCpmmPoolAndLock's own real rent+fee cost comes out of this
      // share before the rest gets swapped into the asset, left behind as
      // native SOL in the platform wallet for createCpmmPoolAndLock to draw
      // on directly below — funded by what the coin's own pre-market
      // trading actually raised, not pre-charged to the creator at launch
      // (see solana.mjs calculateLaunchFeeLamports's own comment on why
      // that changed). row.sol_share_lamports itself stays the real gross
      // share — this reserve is accounted for here, not by changing what
      // got persisted as this asset's share of what was raised.
      const solShareLamports = new BN(row.sol_share_lamports);
      const reserve = new BN(graduationReserveLamports());
      if (!solShareLamports.gt(reserve)) {
        throw new Error(`sol share ${solShareLamports.toString()} too small to cover the graduation reserve (${reserve.toString()}) for ${row.backing_asset_mint}`);
      }
      const swapResult = await swapPlatformSolForAsset({
        assetMint: row.backing_asset_mint,
        amountInLamports: solShareLamports.sub(reserve),
      });
      markGraduationRunAssetSwapped(row.id, swapResult.txId, swapResult.amountOutAtomic);
      swapTx = swapResult.txId;
      assetAmountAtomic = swapResult.amountOutAtomic;
    }

    const poolResult = await createCpmmPoolAndLock({
      coinMint: token.mint_address,
      assetMint: row.backing_asset_mint,
      assetDecimals: assetInfo.decimals,
      assetProgramId,
      coinAmountAtomic: new BN(row.coin_share_atomic),
      assetAmountAtomic,
      totalRewardFeePercent,
    });

    const finalPoolId = randomUUID();
    insertFinalPool({
      id: finalPoolId,
      mintAddress: token.mint_address,
      backingAsset: row.backing_asset,
      backingAssetMint: row.backing_asset_mint,
      decimals: assetInfo.decimals,
      tokenProgram: assetProgramId,
      poolAddress: poolResult.poolId,
      lpMint: poolResult.lpMint,
      lockNftMint: poolResult.lockNftMint,
      swapTx,
      createTx: poolResult.createTx,
      lockTx: poolResult.lockTx,
    });
    markGraduationRunAssetPoolCreated(row.id, finalPoolId);
  } catch (err) {
    // Not rethrown: one asset failing shouldn't stop the others in this run
    // from proceeding. updateGraduationRunStatus below still marks the run
    // 'failed' so it's visible, but the *row* stays retryable — the next
    // cron tick picks this token back up via listGraduatingTokens.
    updateGraduationRunAssetStatus(row.id, 'failed', err.message);
  }
}

async function processToken(token) {
  let run = getIncompleteGraduationRun(token.mint_address);

  if (!run) {
    const pool = token.premarketPool;
    if (!pool) return; // status says premarket but no active pool row — nothing to check yet
    const depleted = await isPreMarketPoolDepleted({
      poolAddress: pool.pool_address,
      tickLower: pool.tick_lower,
      tickUpper: pool.tick_upper,
      coinMint: token.mint_address,
    });
    if (!depleted) return;

    updatePremarketPoolStatus(pool.id, 'closing');
    updateTokenStatus(token.mint_address, 'graduating');
    const id = createGraduationRun(token.mint_address, pool.id);
    run = { id, mint_address: token.mint_address, premarket_pool_id: pool.id, close_tx: null, sol_raised_lamports: null, coin_recovered_atomic: null };
  }

  if (!run.close_tx) {
    const pool = token.premarketPool;
    if (!pool) throw new Error(`graduation run ${run.id}: no premarket pool row found for ${token.mint_address}`);
    try {
      const closeResult = await closePreMarketPool({
        poolId: pool.pool_address,
        positionNftMint: pool.position_nft_mint,
        coinMint: token.mint_address,
      });
      markGraduationRunClosed(run.id, closeResult.txId, closeResult.solReceivedLamports, closeResult.coinReceivedAtomic);
      markPremarketPoolClosed(pool.id, closeResult.txId, closeResult.solReceivedLamports, closeResult.coinReceivedAtomic);
      run = {
        ...run,
        close_tx: closeResult.txId,
        sol_raised_lamports: closeResult.solReceivedLamports.toString(),
        coin_recovered_atomic: closeResult.coinReceivedAtomic.toString(),
      };
    } catch (err) {
      updateGraduationRunStatus(run.id, 'failed', err.message);
      throw err;
    }
  }

  let assetRows = getGraduationRunAssets(run.id);
  if (assetRows.length === 0) {
    // Resolved and stored once, on-chain, at launch time (see launch.mjs
    // assertAssets) — any real mint the creator picked, not looked up
    // against a fixed registry.
    const assets = token.backingAssets;
    if (!assets || assets.length === 0) {
      updateGraduationRunStatus(run.id, 'failed', 'no backing_assets recorded for this token');
      throw new Error(`graduation run ${run.id}: no backing_assets recorded for ${token.mint_address}`);
    }
    const solShares = splitAtomicEvenly(new BN(run.sol_raised_lamports), assets.length);
    const coinShares = splitAtomicEvenly(new BN(run.coin_recovered_atomic), assets.length);
    assetRows = assets.map((asset, i) => {
      const id = insertGraduationRunAsset({
        runId: run.id,
        backingAsset: asset.symbol,
        backingAssetMint: asset.mint,
        solShareLamports: solShares[i],
        coinShareAtomic: coinShares[i],
      });
      return {
        id, backing_asset: asset.symbol, backing_asset_mint: asset.mint,
        sol_share_lamports: solShares[i].toString(), coin_share_atomic: coinShares[i].toString(),
        swap_tx: null, asset_amount_atomic: null, status: 'pending',
      };
    });
  }

  const totalRewardFeePercent = (token.community_fee || 0) + (token.creator_fee || 0) + (token.buyback_fee || 0);
  for (const row of assetRows) {
    await processAsset(token, row, totalRewardFeePercent);
  }

  const settledRows = getGraduationRunAssets(run.id);
  if (settledRows.every((r) => r.status === 'pool_created')) {
    updateGraduationRunStatus(run.id, 'complete');
    updateTokenStatus(token.mint_address, 'complete');
  } else if (settledRows.some((r) => r.status === 'failed')) {
    updateGraduationRunStatus(run.id, 'failed', 'one or more backing assets failed — see graduation_run_assets, retried automatically next cycle');
  }
}

// Entry point for pool-watcher.mjs's real-time account-change subscription
// — a trade the watcher just saw looked like it depleted the pool, so
// check this one token right now rather than waiting for the next cron
// tick. Re-fetches the token fresh from the DB rather than trusting
// whatever the caller already had, since some time (a whole RPC round
// trip, at minimum) passes between "a change notification arrived" and
// here. Swallows its own errors — same as runGraduationCycle's per-token
// catch — so a bad trigger can't crash the long-lived watcher process;
// the cron safety net picks up anything this misses.
export async function triggerGraduationCheck(mintAddress) {
  const token = getPremarketToken(mintAddress);
  if (!token) return; // already past premarket (graduating/complete) or unknown — nothing to do
  try {
    await processToken(token);
  } catch (err) {
    console.error(`graduation check failed for ${mintAddress}:`, err.message);
  }
}

// Entry point for the cron script (graduation-cron.mjs). Two sources feed
// it, same reason rewards.mjs's cycle only has one: a token either just
// became eligible (still 'premarket', pool depleted this tick) or was left
// mid-graduation by a previous crash/redeploy ('graduating' already).
// Sequential, not parallel, for the same reason as runRewardCycle: each
// step is a real transaction against the platform's own wallet, and
// there's no nonce-racing benefit worth the complexity.
export async function runGraduationCycle() {
  const tokens = [...listPremarketTokens(), ...listGraduatingTokens()];
  for (const token of tokens) {
    try {
      await processToken(token);
    } catch (err) {
      console.error(`graduation cycle failed for ${token.mint_address}:`, err.message);
    }
  }
}
