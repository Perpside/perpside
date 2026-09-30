// Real-time graduation trigger: subscribes to every active pre-market
// pool's on-chain account via WebSocket (connection.onAccountChange) so a
// depleting trade gets graduated within moments of confirming, rather than
// waiting for graduation-cron's next 10-minute tick. Needed because trades
// against a pre-market pool aren't limited to our own /api/launch/first-buy
// — it's a real public Raydium pool, so most depleting trades will come
// through Raydium's own UI or Jupiter, which our server has no way to
// learn about except by watching the chain itself.
//
// Lives in the always-on perpside process specifically (started once from
// index.mjs) — a Railway Cron Schedule service has no persistent container
// between runs, so it can't hold a live WebSocket subscription open at all.
// graduation-cron keeps running independently as a safety net: if this
// process restarts, a subscription is missed, or the socket silently drops
// (web3.js's RPC websocket client reconnects on its own, but "on its own"
// isn't a guarantee worth betting the whole feature on), the next cron
// tick still catches anything this misses within its own cadence.
import { PublicKey } from '@solana/web3.js';
import { getConnection, isPoolDataDepleted } from './solana.mjs';
import { listPremarketTokens, getPremarketToken } from './db.mjs';
import { triggerGraduationCheck } from './graduation.mjs';

// mintAddress -> { subscriptionId, poolAddress, tickLower, tickUpper }
const watched = new Map();
// mintAddresses currently mid-triggerGraduationCheck — a burst of trades
// against the same pool can fire several account-change events before the
// first check finishes; without this, each would race to open its own
// graduation_runs row.
const processing = new Set();

async function handleAccountChange(mintAddress, poolMeta, accountData) {
  if (processing.has(mintAddress)) return;
  let depleted;
  try {
    depleted = isPoolDataDepleted(accountData, { tickLower: poolMeta.tickLower, tickUpper: poolMeta.tickUpper, coinMint: mintAddress });
  } catch (err) {
    console.error(`pool-watcher: could not decode account change for ${mintAddress}:`, err.message);
    return;
  }
  if (!depleted) return; // the common case on every trade until the last one — not logged, would be pure noise on an active pool

  console.log(`pool-watcher: ${mintAddress}'s pre-market pool just depleted — triggering graduation now`);
  processing.add(mintAddress);
  try {
    await triggerGraduationCheck(mintAddress);
  } finally {
    processing.delete(mintAddress);
  }
  // If that actually moved the token off 'premarket', stop watching a pool
  // that's now closing/closed — a real depletion (not a false read from a
  // mid-transaction account state) always does this, see graduation.mjs
  // processToken. A still-active token means this was a false alarm (or
  // the graduation attempt itself failed before landing anything), so
  // watching continues.
  if (!getPremarketToken(mintAddress)) unwatchPremarketPool(mintAddress);
}

export function watchPremarketPool({ mintAddress, poolAddress, tickLower, tickUpper }) {
  if (watched.has(mintAddress)) return;
  const connection = getConnection();
  const subscriptionId = connection.onAccountChange(
    new PublicKey(poolAddress),
    (accountInfo) => {
      handleAccountChange(mintAddress, { tickLower, tickUpper }, accountInfo.data).catch((err) => {
        console.error(`pool-watcher: unhandled error for ${mintAddress}:`, err.message);
      });
    },
    'confirmed'
  );
  watched.set(mintAddress, { subscriptionId, poolAddress, tickLower, tickUpper });
}

export function unwatchPremarketPool(mintAddress) {
  const entry = watched.get(mintAddress);
  if (!entry) return;
  getConnection().removeAccountChangeListener(entry.subscriptionId).catch((err) => {
    console.error(`pool-watcher: failed to unsubscribe for ${mintAddress}:`, err.message);
  });
  watched.delete(mintAddress);
}

// Called once from index.mjs at startup — subscribes to whatever's already
// in 'premarket' status (new launches add their own subscription directly
// from launch.mjs right after creating the pool, see watchPremarketPool's
// other call site).
export function startPoolWatcher() {
  const tokens = listPremarketTokens();
  for (const token of tokens) {
    if (!token.premarketPool) continue;
    watchPremarketPool({
      mintAddress: token.mint_address,
      poolAddress: token.premarketPool.pool_address,
      tickLower: token.premarketPool.tick_lower,
      tickUpper: token.premarketPool.tick_upper,
    });
  }
  console.log(`pool-watcher: watching ${watched.size} active pre-market pool(s)`);
}
