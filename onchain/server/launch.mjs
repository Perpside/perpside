import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  mintCoinToken,
  createPoolAndPosition,
  buildFeeTx,
  broadcastFeeTx,
  broadcastSignedTx,
  buildFirstBuyTx,
  getTokenBalance,
  calculateLaunchFeeLamports,
  redactSecrets,
  CLUSTER,
  TOTAL_SUPPLY_WHOLE,
} from './solana.mjs';
import { getSwapQuote, buildSwapTx, SOL_MINT } from './jupiter.mjs';
import { uploadImage, uploadMetadata } from './upload.mjs';
import { insertToken, insertPool, updateTokenStatus, updateTokenMedia, updateFirstBuy, getToken } from './db.mjs';
import { splitSupplyEvenly } from './calibration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// devnet uses the local stand-in mints (backing-assets.json, static prices —
// fine, those tokens have no real market). mainnet-beta requires the
// human-reviewed backing-assets.mainnet.json — see that file's `_verified`
// field and docs/token-launch-plan.md "Open questions"; refusing to boot
// with unverified addresses is deliberate, not a bug.
// backing-assets.mainnet.json carries _verified/_note/_open_question
// alongside the actual XSOL/XBTC/XHYPE entries for human review — strip the
// leading-underscore keys before treating the rest as the asset registry,
// so they can't leak into /api/backing-assets or get looked up as if they
// were a real symbol.
function stripMetaKeys(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !key.startsWith('_')));
}

function loadBackingAssets() {
  if (CLUSTER !== 'mainnet-beta') {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'backing-assets.json')));
  }
  const mainnet = JSON.parse(fs.readFileSync(path.join(__dirname, 'backing-assets.mainnet.json')));
  if (mainnet._verified !== true) {
    throw new Error(
      'backing-assets.mainnet.json has not been marked _verified — confirm the xSOL/xBTC/xHYPE mint addresses against a first-party Hylo source before launching on mainnet-beta'
    );
  }
  return stripMetaKeys(mainnet);
}

const backingAssets = loadBackingAssets();

const MAX_ASSETS = 3;
const DEFAULT_TARGET_FDV_USD = 5000;

export class LaunchValidationError extends Error {}

// devnet stand-in assets have no real market, so calibration uses the
// static usdPrice baked into backing-assets.json. mainnet-beta pairs
// against real, moving markets — calibrating off a stale hardcoded number
// would mis-price the pool and hand arbitrageurs the difference, so this
// fetches a live price from the same Jupiter API the frontend already uses
// for asset search, and refuses to launch if that fails rather than fall
// back to a guess.
async function resolveAssetUsdPrice(asset) {
  if (CLUSTER !== 'mainnet-beta') return asset.usdPrice;
  const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${asset.mint}`);
  if (!res.ok) throw new LaunchValidationError(`could not fetch live price for ${asset.symbol}`);
  const [token] = await res.json();
  if (!token || typeof token.usdPrice !== 'number') {
    throw new LaunchValidationError(`no live price available for ${asset.symbol}`);
  }
  return token.usdPrice;
}

function assertAssets(assetSymbols) {
  if (!Array.isArray(assetSymbols) || assetSymbols.length < 1 || assetSymbols.length > MAX_ASSETS) {
    throw new LaunchValidationError(`pick 1-${MAX_ASSETS} backing assets`);
  }
  return assetSymbols.map((symbol) => {
    const asset = backingAssets[symbol];
    if (!asset) throw new LaunchValidationError(`unknown backing asset: ${symbol}`);
    return { symbol, ...asset };
  });
}

// Step 1: build the launch fee transfer (creator -> platform, sized to the
// real cost of minting + N pools, see calculateLaunchFeeLamports). This is
// the only thing the creator ever signs — everything downstream is
// platform-sponsored and platform-signed.
export function prepareFee({ creatorWallet, assetSymbols }) {
  if (!creatorWallet) throw new LaunchValidationError('connect a wallet before launching');
  assertAssets(assetSymbols);
  const feeLamports = calculateLaunchFeeLamports(assetSymbols.length);
  // `cluster` tells the frontend which network this transaction was built
  // against, so it can pass the matching Wallet Standard `chain` string
  // when asking for a signature — hardcoding that client-side would silently
  // go stale the moment CLUSTER flips.
  return buildFeeTx(creatorWallet, feeLamports).then((txBase64) => ({ txBase64, feeLamports, cluster: CLUSTER }));
}

// Step 2: broadcast the creator-signed fee tx, confirm it landed (that
// confirmation is itself the proof the creator paid — see solana.mjs), then
// run the platform-sponsored mint + pool creation exactly as before.
export async function launchToken({ name, ticker, imageDataUrl, assetSymbols, creatorWallet, signedFeeTxBase64 }) {
  if (!creatorWallet) throw new LaunchValidationError('connect a wallet before launching');
  if (!name || !ticker) throw new LaunchValidationError('name and ticker are required');
  if (!signedFeeTxBase64) throw new LaunchValidationError('launch fee payment is required');
  const assets = assertAssets(assetSymbols);

  try {
    await broadcastFeeTx(signedFeeTxBase64);
  } catch (err) {
    throw new LaunchValidationError('launch fee payment failed: ' + redactSecrets(err.message));
  }

  // From here on the creator has already paid — a thrown error no longer
  // means "nothing happened", it means "stuck partway". Status is recorded
  // against the mint address as soon as it exists, so a partial failure is
  // a visible, diagnosable DB row instead of a silently dropped launch (see
  // db.mjs status/error_message columns).
  const { mint } = await mintCoinToken();
  insertToken({ mintAddress: mint, name, ticker, imageUrl: null, metadataUri: null, creatorWallet, firstBuyLamports: null, status: 'minting' });

  try {
    const imageUrl = imageDataUrl ? await uploadImage(mint, imageDataUrl) : null;
    const metadataUri = await uploadMetadata(mint, {
      name,
      symbol: ticker,
      description: `${name} (${ticker}) — launched on Perpside`,
      image: imageUrl,
    });

    updateTokenMedia(mint, imageUrl, metadataUri);
    updateTokenStatus(mint, 'pools_pending');

    const shares = splitSupplyEvenly(1_000_000_000n, assets.length);
    const pools = [];
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const usdPrice = await resolveAssetUsdPrice(asset);
      const result = await createPoolAndPosition({
        coinMint: mint,
        asset: { ...asset, usdPrice },
        targetFdvUsd: DEFAULT_TARGET_FDV_USD,
        coinShareWhole: shares[i],
      });

      insertPool({
        id: randomUUID(),
        mintAddress: mint,
        backingAsset: asset.symbol,
        backingAssetMint: asset.mint,
        poolAddress: result.poolId,
        positionNftMint: result.positionNftMint,
        tickLower: result.tickLower,
        tickUpper: result.tickUpper,
        initialPrice: result.startPrice,
      });

      pools.push({ asset: asset.symbol, ...result });
    }

    updateTokenStatus(mint, 'complete');
    return { mint, imageUrl, metadataUri, pools };
  } catch (err) {
    updateTokenStatus(mint, 'failed', err.message);
    throw err;
  }
}

export function listBackingAssets() {
  return backingAssets;
}

// Economics the frontend needs to estimate a First Buy's COIN payout before
// the coin (and its pool) even exists — every launch starts at the same
// targetFdvUsd / totalSupplyWhole price, so this is enough for a rough
// client-side estimate without a new round trip per keystroke.
export function getLaunchConfig() {
  return { targetFdvUsd: DEFAULT_TARGET_FDV_USD, totalSupplyWhole: Number(TOTAL_SUPPLY_WHOLE) };
}

// First Buy: optional, creator-signed, lands COIN in the creator's own
// wallet — never the platform's. Our pools only pair COIN against
// xSOL/xBTC/xHYPE, not native SOL, so this is unavoidably two hops:
//   1. SOL -> backing asset, via Jupiter (mainnet-only — Jupiter doesn't
//      route devnet tokens, so First Buy simply isn't available there).
//   2. backing asset -> COIN, via the pool this launch just created.
// Two separate creator signatures rather than one combined transaction —
// composing Jupiter's returned instructions with our own Raydium swap in a
// single versioned tx (shared address-lookup-tables, exact accounts) is
// real complexity for a UX win (one popup instead of two) on a feature
// that's opt-in to begin with. Each hop reuses the same
// prepare-unsigned-tx -> sign -> broadcast pattern as the launch fee.
function firstBuyPool(mint) {
  const token = getToken(mint);
  if (!token || !token.pools.length) throw new LaunchValidationError('unknown or incomplete launch');
  return token.pools[0]; // whichever backing asset was picked first
}

export async function prepareFirstBuyHop1({ mint, buyerWallet, solLamports }) {
  if (CLUSTER !== 'mainnet-beta') {
    throw new LaunchValidationError('First Buy needs mainnet — Jupiter has no devnet liquidity to route through');
  }
  if (!buyerWallet) throw new LaunchValidationError('connect a wallet before buying');
  if (!solLamports || solLamports <= 0) throw new LaunchValidationError('invalid first-buy amount');

  const pool = firstBuyPool(mint);
  const quote = await getSwapQuote({ inputMint: SOL_MINT, outputMint: pool.backing_asset_mint, amountLamports: solLamports });
  const txBase64 = await buildSwapTx({ quoteResponse: quote, userPublicKey: buyerWallet });
  return { txBase64, cluster: CLUSTER };
}

export function broadcastFirstBuyHop1({ signedTxBase64 }) {
  if (!signedTxBase64) throw new LaunchValidationError('signed transaction is required');
  return broadcastSignedTx(signedTxBase64, 'first-buy swap (hop 1)').then((txId) => ({ txId }));
}

export async function prepareFirstBuyHop2({ mint, buyerWallet }) {
  // No CLUSTER gate here — unlike hop 1, this is pure Raydium pool
  // interaction with no Jupiter dependency, so it's cluster-agnostic. In
  // the normal flow it's only ever reached after hop 1 succeeds (which
  // *is* mainnet-gated), but that's a frontend sequencing fact, not
  // something this function needs to assume.
  if (!buyerWallet) throw new LaunchValidationError('connect a wallet before buying');

  const pool = firstBuyPool(mint);
  // Spend whatever hop 1 actually delivered, not the pre-swap quote's
  // estimate — reading the real post-hop-1 balance means hop 2 can never
  // ask for more than the wallet actually holds.
  const amountIn = await getTokenBalance(buyerWallet, pool.backing_asset_mint);
  if (amountIn.isZero()) throw new LaunchValidationError('no balance to buy with — did the first swap land?');

  const txBase64 = await buildFirstBuyTx({
    poolId: pool.pool_address,
    coinMint: mint,
    assetMint: pool.backing_asset_mint,
    buyerWallet,
    amountIn,
  });
  return { txBase64, cluster: CLUSTER };
}

export async function broadcastFirstBuyHop2({ mint, signedTxBase64, solLamportsSpent }) {
  if (!signedTxBase64) throw new LaunchValidationError('signed transaction is required');
  const txId = await broadcastSignedTx(signedTxBase64, 'first-buy swap (hop 2)');
  updateFirstBuy(mint, solLamportsSpent ?? null);
  return { txId };
}
