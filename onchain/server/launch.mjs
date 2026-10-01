import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
  mintCoinToken,
  createPreMarketPool,
  buildFeeTx,
  broadcastFeeTx,
  broadcastSignedTx,
  buildFirstBuyTx,
  calculateLaunchFeeLamports,
  redactSecrets,
  listFeeTierPercents,
  getMintDecimals,
  CLUSTER,
  TOTAL_SUPPLY_WHOLE,
  COIN_DECIMALS,
} from './solana.mjs';
import { SOL_MINT } from './jupiter.mjs';
import { uploadImage, uploadMetadata } from './upload.mjs';
import { insertToken, insertPremarketPool, updateTokenStatus, updateFirstBuy, getActivePremarketPool } from './db.mjs';
import { watchPremarketPool } from './pool-watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This registry is no longer the exclusive set of what a launch CAN use as
// a backing asset (see assertAssets below — any real mint is accepted now,
// per the user's own direction) — it's just the featured/default picks
// /api/backing-assets hands the frontend's 3 pre-filled pills, and a
// convenient known-price lookup rewards.mjs uses for these specific assets
// on devnet (see rewards.mjs getKnownDevnetUsdPrice). devnet uses the
// local stand-in mints (backing-assets.json, static prices — fine, those
// tokens have no real market). mainnet-beta requires the human-reviewed
// backing-assets.mainnet.json — see that file's `_verified` field and
// docs/token-launch-plan.md "Open questions"; refusing to boot with
// unverified addresses is deliberate, not a bug.
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

// Any real mint on this cluster is accepted as a backing asset — not just
// the three Hylo registry ones. Still validated and resolved at launch
// time even though the new pre-market model doesn't touch a backing asset
// until graduation: the creator's choice here (symbol + mint, decimals
// resolved on-chain right now) is what graduation.mjs later splits the
// recovered SOL/COIN across (see db.mjs tokens.backing_assets and
// docs/token-launch-plan.md "Graduation") — resolving decimals once here
// means nothing downstream (createCpmmPoolAndLock, rewards.mjs) needs to
// re-fetch or guess it later.
async function assertAssets(assets) {
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > MAX_ASSETS) {
    throw new LaunchValidationError(`pick 1-${MAX_ASSETS} backing assets`);
  }
  const seen = new Set();
  const resolved = [];
  for (const raw of assets) {
    const symbol = typeof raw?.symbol === 'string' ? raw.symbol.trim() : '';
    const mintInput = typeof raw?.mint === 'string' ? raw.mint.trim() : '';
    if (!symbol || !mintInput) throw new LaunchValidationError('each backing asset needs a symbol and a mint address');
    if (symbol.length > 10) throw new LaunchValidationError(`${symbol}: symbol too long (max 10 characters)`);

    let mintPubkey;
    try {
      mintPubkey = new PublicKey(mintInput);
    } catch {
      throw new LaunchValidationError(`${symbol}: "${mintInput}" is not a valid mint address`);
    }
    const mint = mintPubkey.toBase58();
    if (seen.has(mint)) throw new LaunchValidationError('backing assets must be unique');
    seen.add(mint);

    let decimals;
    try {
      decimals = await getMintDecimals(mint);
    } catch (err) {
      // getMintDecimals' own message already distinguishes "no real mint
      // here at all" from "real mint, but Token-2022" — surfaced as-is
      // rather than flattened into one generic message.
      throw new LaunchValidationError(`${symbol}: ${err.message}`);
    }
    resolved.push({ symbol: symbol.toUpperCase(), mint, decimals });
  }
  return resolved;
}

// Step 1: build the launch fee transfer (creator -> platform, sized to the
// real cost of minting + the pre-market pool + N backing assets' worth of
// graduation cost, see calculateLaunchFeeLamports). This is the only thing
// the creator ever signs — everything downstream is platform-sponsored and
// platform-signed.
export async function prepareFee({ creatorWallet, assets }) {
  if (!creatorWallet) throw new LaunchValidationError('connect a wallet before launching');
  await assertAssets(assets);
  const feeLamports = calculateLaunchFeeLamports(assets.length);
  // `cluster` tells the frontend which network this transaction was built
  // against, so it can pass the matching Wallet Standard `chain` string
  // when asking for a signature — hardcoding that client-side would silently
  // go stale the moment CLUSTER flips.
  const txBase64 = await buildFeeTx(creatorWallet, feeLamports);
  return { txBase64, feeLamports, cluster: CLUSTER };
}

// Step 2: broadcast the creator-signed fee tx, confirm it landed (that
// confirmation is itself the proof the creator paid — see solana.mjs), then
// mint the coin and open its pre-market position, platform-sponsored. Unlike
// the old model, this does *not* create the launch's real final pools —
// those don't exist until graduation (see graduation.mjs), once the
// pre-market position sells through. A token sits in 'premarket' status,
// already genuinely tradeable (it's a real Raydium pool from the moment
// this lands), until that happens.
export async function launchToken({
  name, ticker, imageDataUrl, assets, creatorWallet, signedFeeTxBase64,
  xLink, telegramLink, websiteLink, communityFee, creatorFee, buybackFee,
}) {
  if (!creatorWallet) throw new LaunchValidationError('connect a wallet before launching');
  if (!name || !ticker) throw new LaunchValidationError('name and ticker are required');
  // Checked before the fee is ever charged, not after — these map directly
  // to Metaplex's fixed on-chain field sizes for the metadata mintCoinToken
  // creates, so a value that fails here would otherwise burn the creator's
  // fee on a launch that can't finish.
  if (Buffer.byteLength(name, 'utf8') > 32) throw new LaunchValidationError('name is too long for on-chain metadata (max 32 bytes)');
  if (Buffer.byteLength(ticker, 'utf8') > 10) throw new LaunchValidationError('ticker is too long for on-chain metadata (max 10 bytes)');
  if (!signedFeeTxBase64) throw new LaunchValidationError('launch fee payment is required');
  const resolvedAssets = await assertAssets(assets);

  try {
    await broadcastFeeTx(signedFeeTxBase64);
  } catch (err) {
    throw new LaunchValidationError('launch fee payment failed: ' + redactSecrets(err.message));
  }

  // Image/metadata need to be uploaded *before* minting now — the coin's
  // on-chain Metaplex metadata (created in the same transaction as the
  // mint itself, see mintCoinToken) needs a real URI to point at, and that
  // only exists once the upload lands.
  const imageUrl = imageDataUrl ? await uploadImage(imageDataUrl) : null;
  const metadataUri = await uploadMetadata({
    name,
    symbol: ticker,
    description: `${name} (${ticker}) — launched on Perpside`,
    image: imageUrl,
  });

  // From here on the creator has already paid — a thrown error no longer
  // means "nothing happened", it means "stuck partway". Status is recorded
  // against the mint address as soon as it exists, so a partial failure is
  // a visible, diagnosable DB row instead of a silently dropped launch (see
  // db.mjs status/error_message columns).
  const { mint } = await mintCoinToken({ name, symbol: ticker, metadataUri });
  insertToken({
    mintAddress: mint, name, ticker, imageUrl, metadataUri, creatorWallet, firstBuyLamports: null, status: 'minting',
    xLink, telegramLink, websiteLink, communityFee, creatorFee, buybackFee, backingAssets: resolvedAssets,
  });

  try {
    const pool = await createPreMarketPool({ coinMint: mint });
    insertPremarketPool({
      id: randomUUID(),
      mintAddress: mint,
      poolAddress: pool.poolId,
      positionNftMint: pool.positionNftMint,
      tickLower: pool.tickLower,
      tickUpper: pool.tickUpper,
      initialPrice: pool.startPrice,
    });
    updateTokenStatus(mint, 'premarket');
    // graduation-cron would pick this pool up within its own 10-minute
    // cadence regardless, but subscribing right now means a depleting
    // trade against a fresh launch gets graduated immediately instead of
    // waiting for the first tick — see pool-watcher.mjs.
    watchPremarketPool({ mintAddress: mint, poolAddress: pool.poolId, tickLower: pool.tickLower, tickUpper: pool.tickUpper });
    return { mint, imageUrl, metadataUri, pool };
  } catch (err) {
    updateTokenStatus(mint, 'failed', err.message);
    throw err;
  }
}

export function listBackingAssets() {
  return backingAssets;
}

// A creator buying up a big chunk of supply for themselves right at launch
// looks like a rug-pull setup regardless of intent — cap First Buy so it
// can never land more than this fraction of total supply. Enforced against
// the real swap simulation before a signable transaction ever goes back to
// the client (see prepareFirstBuy).
const FIRST_BUY_MAX_SUPPLY_FRACTION = 0.1;

function maxFirstBuyCoinAtomic() {
  return (TOTAL_SUPPLY_WHOLE * 10n ** BigInt(COIN_DECIMALS) * 10n) / 100n; // 10%, integer-exact
}

function assertWithinFirstBuyCap(coinAmountAtomic) {
  if (coinAmountAtomic > maxFirstBuyCoinAtomic()) {
    throw new LaunchValidationError(
      `First Buy is capped at ${FIRST_BUY_MAX_SUPPLY_FRACTION * 100}% of total supply — try a smaller amount`
    );
  }
}

// Economics the frontend needs to estimate a First Buy's COIN payout before
// the coin (and its pool) even exists — every launch starts at the same
// targetFdvUsd / totalSupplyWhole price, so this is enough for a rough
// client-side estimate without a new round trip per keystroke.
export function getLaunchConfig() {
  return {
    targetFdvUsd: DEFAULT_TARGET_FDV_USD,
    totalSupplyWhole: Number(TOTAL_SUPPLY_WHOLE),
    coinDecimals: COIN_DECIMALS,
    maxFirstBuySupplyFraction: FIRST_BUY_MAX_SUPPLY_FRACTION,
    // The reward model's total fee is a choice among these, not a free
    // slider — anything else can't map onto a real pool (see solana.mjs
    // pickAmmConfig/pickCpmmConfig/listFeeTierPercents). Always mainnet's
    // tiers capped at 3% (the reward model's original ceiling), regardless
    // of which cluster is actually live right now — devnet's own tier list
    // tops out at 0.25%, far too narrow a range for creators to configure a
    // meaningful split against.
    feeTiers: listFeeTierPercents({ cluster: 'mainnet-beta', maxPercent: 3 }),
  };
}

// First Buy: optional, creator-signed, lands COIN in the creator's own
// wallet — never the platform's. Under the old model this needed two hops
// (pools only paired COIN against a backing asset, so buying required
// SOL -> asset via Jupiter, then asset -> COIN via the pool). The
// pre-market pool pairs COIN directly against native SOL, so this is now a
// single hop straight through it, with no Jupiter dependency at all —
// which also means, unlike the old hop 1, this isn't mainnet-only anymore.
function activePremarketPool(mint) {
  const pool = getActivePremarketPool(mint);
  if (!pool) throw new LaunchValidationError('unknown or incomplete launch — no active pre-market pool to buy against');
  return pool;
}

export async function prepareFirstBuy({ mint, buyerWallet, solLamports }) {
  if (!buyerWallet) throw new LaunchValidationError('connect a wallet before buying');
  if (!solLamports || solLamports <= 0) throw new LaunchValidationError('invalid first-buy amount');

  const pool = activePremarketPool(mint);
  const result = await buildFirstBuyTx({
    poolId: pool.pool_address,
    coinMint: mint,
    assetMint: SOL_MINT,
    buyerWallet,
    amountIn: new BN(solLamports),
  });
  // Precise — checked against the swap simulation's own output estimate,
  // which reflects this pool's real current price and liquidity, not a
  // pre-swap guess. Rejected here, before a signable transaction ever goes
  // back to the client.
  assertWithinFirstBuyCap(BigInt(result.coinAmountOut));
  return { txBase64: result.txBase64, cluster: CLUSTER };
}

export async function broadcastFirstBuy({ mint, signedTxBase64, solLamportsSpent }) {
  if (!signedTxBase64) throw new LaunchValidationError('signed transaction is required');
  const txId = await broadcastSignedTx(signedTxBase64, 'first-buy swap');
  updateFirstBuy(mint, solLamportsSpent ?? null);
  return { txId };
}
