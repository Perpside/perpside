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
import { closePreMarketPool, swapPlatformSolForAsset, createCpmmPoolAndLock, isPreMarketPoolDepleted } from './solana.mjs';
import { listBackingAssets } from './launch.mjs';
import {
  listPremarketTokens,
  listGraduatingTokens,
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

// Same "split total, remainder folded into the last share" approach as
// calibration.mjs splitSupplyEvenly, just over a BN instead of a BigInt —
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
    let swapTx = row.swap_tx;
    let assetAmountAtomic = row.asset_amount_atomic ? new BN(row.asset_amount_atomic) : null;
    if (!swapTx) {
      const swapResult = await swapPlatformSolForAsset({
        assetMint: row.backing_asset_mint,
        amountInLamports: new BN(row.sol_share_lamports),
      });
      markGraduationRunAssetSwapped(row.id, swapResult.txId, swapResult.amountOutAtomic);
      swapTx = swapResult.txId;
      assetAmountAtomic = swapResult.amountOutAtomic;
    }

    const poolResult = await createCpmmPoolAndLock({
      coinMint: token.mint_address,
      assetMint: row.backing_asset_mint,
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
    const symbols = token.backingAssetSymbols;
    if (!symbols || symbols.length === 0) {
      updateGraduationRunStatus(run.id, 'failed', 'no backing_assets recorded for this token');
      throw new Error(`graduation run ${run.id}: no backing_assets recorded for ${token.mint_address}`);
    }
    const registry = listBackingAssets();
    const solShares = splitAtomicEvenly(new BN(run.sol_raised_lamports), symbols.length);
    const coinShares = splitAtomicEvenly(new BN(run.coin_recovered_atomic), symbols.length);
    assetRows = symbols.map((symbol, i) => {
      const asset = registry[symbol];
      const id = insertGraduationRunAsset({
        runId: run.id,
        backingAsset: symbol,
        backingAssetMint: asset.mint,
        solShareLamports: solShares[i],
        coinShareAtomic: coinShares[i],
      });
      return {
        id, backing_asset: symbol, backing_asset_mint: asset.mint,
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
