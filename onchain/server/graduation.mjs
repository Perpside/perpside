// Orchestrates graduation: the pre-market position is closed (see
// solana.mjs closePreMarketPool), the SOL it held is split across however
// many backing assets this launch configured and swapped into each one
// (mainnet-only — see swapPlatformSolForAsset), and the COIN held back
// from the pre-market allocation is split the same way to seed the real
// final pools (CPMM, see createCpmmPoolAndLock). Mirrors rewards.mjs's
// layering: solana.mjs holds the single on-chain operations, this file
// composes them into the actual business process.
import BN from 'bn.js';
import { closePreMarketPool, swapPlatformSolForAsset, createCpmmPoolAndLock } from './solana.mjs';

// Same "split total, remainder folded into the last share" approach as
// calibration.mjs splitSupplyEvenly, just over a BN instead of a BigInt —
// atomic lamport/token amounts flow through solana.mjs as BN, not BigInt.
function splitAtomicEvenly(total, n) {
  const base = total.divn(n);
  const remainder = total.sub(base.muln(n));
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? base.add(remainder) : base));
}

// `backingAssets`: the same [{ symbol, mint }, ...] shape launch.mjs
// already builds from backing-assets.json — 1 to 3 entries, matching
// whatever the creator picked at launch. Returns per-asset results so the
// caller (not built yet — see docs/token-launch-plan.md "Graduation") can
// persist each pool as it's created, rather than only learning about the
// whole thing after every step succeeds.
export async function graduateToken({ coinMint, poolId, positionNftMint, backingAssets, totalRewardFeePercent }) {
  const closeResult = await closePreMarketPool({ poolId, positionNftMint, coinMint });

  const n = backingAssets.length;
  const solShares = splitAtomicEvenly(closeResult.solReceivedLamports, n);
  const coinShares = splitAtomicEvenly(closeResult.coinReceivedAtomic, n);

  const pools = [];
  for (let i = 0; i < n; i++) {
    const asset = backingAssets[i];
    const swapResult = await swapPlatformSolForAsset({ assetMint: asset.mint, amountInLamports: solShares[i] });
    const poolResult = await createCpmmPoolAndLock({
      coinMint,
      assetMint: asset.mint,
      coinAmountAtomic: coinShares[i],
      assetAmountAtomic: swapResult.amountOutAtomic,
      totalRewardFeePercent,
    });
    pools.push({ asset: asset.symbol, assetMint: asset.mint, swapTx: swapResult.txId, ...poolResult });
  }

  return {
    closeTx: closeResult.txId,
    solRaisedLamports: closeResult.solReceivedLamports.toString(),
    pools,
  };
}
