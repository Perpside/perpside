import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  createBurnInstruction,
  AuthorityType,
  getAssociatedTokenAddress,
  getAccount,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PROGRAM_ID as METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
  createUpdateMetadataAccountV2Instruction,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  Raydium,
  DEVNET_PROGRAM_ID,
  CLMM_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  LOCK_CPMM_PROGRAM,
  LOCK_CPMM_AUTH,
  TxVersion,
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  getCpLockPda,
  getPdaPoolAuthority,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickArrayBitmapExtensionLayout,
  swapInternal,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCoinMintA, calibratePreMarketPool } from './calibration.mjs';
import { SOL_MINT, getSwapQuote, buildSwapTx } from './jupiter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single switch for the whole backend: 'devnet' (default) or 'mainnet-beta'.
// Everything below (RPC, program IDs, AMM config) branches off this instead
// of hardcoding devnet — see docs/token-launch-plan.md "Rollout steps".
export const CLUSTER = process.env.CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
export const RPC_URL = process.env.RPC_URL || process.env.DEVNET_RPC_URL;
if (!RPC_URL) throw new Error('set RPC_URL (or the legacy DEVNET_RPC_URL) in .env');
// Caught the hard way: CLUSTER can be flipped to mainnet-beta independently
// of RPC_URL, and every PDA derivation below silently uses whichever
// program IDs CLUSTER says — against whatever RPC_URL actually points at.
// A devnet RPC_URL with CLUSTER=mainnet-beta doesn't error, it just derives
// addresses that don't exist on the endpoint it's querying (see
// getPoolPendingFees/harvestPoolFees's "stale row" errors).
if (CLUSTER === 'mainnet-beta' && /devnet/i.test(RPC_URL)) {
  console.warn('CLUSTER=mainnet-beta but RPC_URL looks like a devnet endpoint — this will not work, set a real mainnet RPC_URL.');
}

export const CLMM_PROGRAM_ID_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CLMM_PROGRAM_ID : DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
export const CREATE_CPMM_POOL_PROGRAM_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
export const CREATE_CPMM_POOL_FEE_ACC_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CREATE_CPMM_POOL_FEE_ACC : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC;
export const LOCK_CPMM_PROGRAM_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? LOCK_CPMM_PROGRAM : DEVNET_PROGRAM_ID.LOCK_CPMM_PROGRAM;
export const LOCK_CPMM_AUTH_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? LOCK_CPMM_AUTH : DEVNET_PROGRAM_ID.LOCK_CPMM_AUTH;
// The address every CPMM pool's vaults are owned by — one PDA shared across
// every pool on the program (getPdaPoolAuthority only seeds on programId,
// not poolId), not a per-pool address. The reward cron needs this to
// exclude a pool's own reserves from "real holders" when splitting the
// community pot (see rewards.mjs getRealHolders) — confirmed by reading
// getPdaPoolAuthority's own seed list, not assumed from the CLMM pattern
// (CLMM's per-pool vault ownership doesn't generalize here).
export const CPMM_POOL_AUTHORITY_FOR_CLUSTER = getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM_FOR_CLUSTER).publicKey;

// Some RPC-client error messages embed the request URL, which carries our
// API key in its query string — strip it before any such message can reach
// a LaunchValidationError, which is shown verbatim to the client to help
// them debug a failed transaction (see launch.mjs launchToken()).
export function redactSecrets(message) {
  return typeof message === 'string' ? message.split(RPC_URL).join('[rpc]') : message;
}

// Every CLMM fee tier Raydium has published, per cluster — fetched directly
// from their own config API (api-v3[-devnet].raydium.io/main/clmm-config)
// on 2026-09-29. Re-verify before relying on this in a real deploy; Raydium
// controls this list (creating a new tier is admin-gated on their program,
// confirmed by reading raydium-clmm's create_amm_config.rs — not something
// we can do ourselves), so it only changes if *they* add one.
// tradeFeeRate is parts-per-million (2500 = 0.25%); protocolFeeRate/
// fundFeeRate are identical across every tier on both clusters.
const DEVNET_AMM_CONFIGS = [
  { id: 'F8aaMZVpXaQHk3Qo9BPDhsa7RgpfrfiRsk8L3iXnq3AT', index: 1, tradeFeeRate: 100, tickSpacing: 1 },
  { id: 'FZdkW5jiYsjTnCVqFqPrxrQisQkCYrohd7ArZhoKnM8q', index: 2, tradeFeeRate: 500, tickSpacing: 10 },
  { id: 'CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu', index: 0, tradeFeeRate: 2500, tickSpacing: 60 },
];
const MAINNET_AMM_CONFIGS = [
  { id: '9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x', index: 4, tradeFeeRate: 100, tickSpacing: 1 },
  { id: 'EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR', index: 6, tradeFeeRate: 200, tickSpacing: 1 },
  { id: '9EeWRCL8CJnikDFCDzG8rtmBs5KQR1jEYKCR5rRZ2NEi', index: 7, tradeFeeRate: 300, tickSpacing: 1 },
  { id: '3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL', index: 8, tradeFeeRate: 400, tickSpacing: 1 },
  { id: '3XCQJQryqpDvvZBfGxR7CLAw5dpGJ9aa7kt1jRLdyxuZ', index: 5, tradeFeeRate: 500, tickSpacing: 1 },
  { id: 'DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY', index: 10, tradeFeeRate: 1000, tickSpacing: 10 },
  { id: 'J8u7HvA1g1p2CdhBFdsnTxDzGkekRpdw4GrL9MKU2D3U', index: 11, tradeFeeRate: 1500, tickSpacing: 10 },
  { id: 'RPxHtdN5V7ajwkoG6NnwSBAeaX5k9giY37dpp98xTjD', index: 12, tradeFeeRate: 1600, tickSpacing: 10 },
  { id: '9WjDVMHWCirG9jkchbetHTnSzdXbAPnD9bsoGRcz1xUw', index: 13, tradeFeeRate: 1800, tickSpacing: 10 },
  { id: 'FMrUDGjEe1izXPbn8SZPNjMfB5JvvhVq5ymmpZDebB5R', index: 14, tradeFeeRate: 2000, tickSpacing: 10 },
  { id: 'E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp', index: 1, tradeFeeRate: 2500, tickSpacing: 60 },
  { id: 'Y6YhgJbt9FRk3JVjwdZtsioVCJwCKhy1hum8HMDYyB1', index: 15, tradeFeeRate: 4000, tickSpacing: 60 },
  { id: '47Nq74YtwjVeTQF6KFKRKU4cY1Vd5AXBHpYRkubkDLZi', index: 16, tradeFeeRate: 6000, tickSpacing: 60 },
  { id: 'DQeN7dZyQvXKT7YwmgqyuC7AYFkwMoP7RwtucsDEdfYZ', index: 17, tradeFeeRate: 8000, tickSpacing: 60 },
  { id: 'A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x', index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
  { id: 'Gex2NJRS3jVLPfbzSFM5d5DRsNoL5ynnwT1TXoDEhanz', index: 9, tradeFeeRate: 20000, tickSpacing: 120 },
  { id: 'CDpiwv9eLsRvvuzZEJ8CBtK14wdvkSnkub4vmGtzzdK8', index: 18, tradeFeeRate: 30000, tickSpacing: 120 },
  { id: '6tBc3ABLaYTTWu94DiRD5PWi92HML34UpAQ8pPTYgudw', index: 19, tradeFeeRate: 40000, tickSpacing: 120 },
];

function toAmmConfig(entry) {
  return {
    id: new PublicKey(entry.id),
    index: entry.index,
    protocolFeeRate: 120000,
    tradeFeeRate: entry.tradeFeeRate,
    tickSpacing: entry.tickSpacing,
    fundFeeRate: 40000,
    fundOwner: '',
    description: '',
  };
}

// Snaps a creator's configured reward-fee total (e.g. 1.5, meaning 1.5%) to
// whichever published Raydium tier is numerically closest — there's no way
// to get a pool charging exactly what was configured, only the nearest
// tier Raydium actually offers (creating a custom one isn't possible, see
// above). Defaults to the flat 0.25% tier when nothing was configured.
export function pickAmmConfig(totalFeePercent) {
  const configs = CLUSTER === 'mainnet-beta' ? MAINNET_AMM_CONFIGS : DEVNET_AMM_CONFIGS;
  if (!totalFeePercent || totalFeePercent <= 0) {
    return toAmmConfig(configs.find((c) => c.tradeFeeRate === 2500) ?? configs[0]);
  }
  const targetRate = totalFeePercent * 10000; // 1% = 10000 in tradeFeeRate units
  const closest = configs.reduce((best, c) =>
    Math.abs(c.tradeFeeRate - targetRate) < Math.abs(best.tradeFeeRate - targetRate) ? c : best
  );
  return toAmmConfig(closest);
}

// The frontend can't offer a fee choice that pickAmmConfig can't actually
// honor — so instead of a free-form slider up to some cap, it needs the
// exact list of tiers Raydium publishes to build a picker from. Sorted
// ascending, deduplicated by rate. Takes an explicit `cluster` rather than
// always reading the live `CLUSTER` — devnet only has 3 tiers topping out
// at 0.25%, nowhere near enough range for a usable reward-model picker, so
// the launch form is meant to show mainnet's real tiers even while running
// against devnet (see listFeeTierPercents's caller in launch.mjs). Once
// CLUSTER actually is 'mainnet-beta' in production, this becomes exactly
// the live tier list — no behavior change at that point, just the same
// list arriving early.
export function listFeeTierPercents({ cluster = CLUSTER, maxPercent } = {}) {
  const configs = cluster === 'mainnet-beta' ? MAINNET_AMM_CONFIGS : DEVNET_AMM_CONFIGS;
  const percents = [...new Set(configs.map((c) => c.tradeFeeRate / 10000))].sort((a, b) => a - b);
  return typeof maxPercent === 'number' ? percents.filter((p) => p <= maxPercent) : percents;
}

// Final-pool fee configs for Raydium's *standard* AMM (CPMM), not CLMM —
// graduation deposits real two-sided liquidity (COIN + whatever the raised
// SOL bought), and a plain constant-product pool has no tick range to
// calibrate a ceiling into, which is the entire reason it's used here
// instead of CLMM for the post-graduation pools (see
// docs/token-launch-plan.md "Graduation"). `creatorFeeRate` is a *separate*
// protocol-native fee (not a slice of tradeFeeRate — some tiers have
// creatorFeeRate exceeding tradeFeeRate, confirmed against Raydium's own
// numbers below), claimable directly via collectCreatorFees, so it funds
// the reward model's Creator leg without any custom harvest logic.
// Sourced live from api-v3[-devnet].raydium.io/main/cpmm-config on
// 2026-09-30; `showWithUI: true` entries only (the others are unlisted/
// partner-specific tiers, same reasoning as the CLMM config list).
const DEVNET_CPMM_CONFIGS = [
  { id: '5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy', index: 0, tradeFeeRate: 2500, creatorFeeRate: 2500 },
  { id: 'HTVWgp8CbUsRNmRE1p9RBYqopxe2qiyApSkiTFLrfxaW', index: 1, tradeFeeRate: 3000, creatorFeeRate: 2500 },
  { id: 'A9qBhPy4k5UYW72hSgAkh1Epr2do69P54yzzcMV3yv6b', index: 2, tradeFeeRate: 5000, creatorFeeRate: 2500 },
  { id: 'EsTevfacYXpuho5VBuzBjDZi8dtWidGnXoSYAr8krTvz', index: 3, tradeFeeRate: 10000, creatorFeeRate: 2500 },
  { id: '5Gt9qrPJ6FVe9VHtwF2W2JrFR6p9jmx4DxBkgfPdaApk', index: 4, tradeFeeRate: 40000, creatorFeeRate: 2500 },
];
const MAINNET_CPMM_CONFIGS = [
  { id: 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2', index: 0, tradeFeeRate: 2500, creatorFeeRate: 500 },
  { id: 'BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP', index: 5, tradeFeeRate: 3000, creatorFeeRate: 500 },
  { id: 'BhH6HphjBKXu2PkUc2aw3xEMdUvK14NXxE5LbNWZNZAA', index: 4, tradeFeeRate: 5000, creatorFeeRate: 500 },
  { id: 'G95xxie3XbkCqtE39GgQ9Ggc7xBC8Uceve7HFDEFApkc', index: 1, tradeFeeRate: 10000, creatorFeeRate: 500 },
  { id: 'B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2', index: 6, tradeFeeRate: 15000, creatorFeeRate: 500 },
  { id: '2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5', index: 2, tradeFeeRate: 20000, creatorFeeRate: 500 },
  { id: 'ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi', index: 7, tradeFeeRate: 25000, creatorFeeRate: 500 },
  { id: 'C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2', index: 3, tradeFeeRate: 40000, creatorFeeRate: 500 },
];
const CPMM_SHARED_FIELDS = { protocolFeeRate: 120000, fundFeeRate: 40000, createPoolFee: '150000000' };

function toCpmmConfig(entry) {
  return { ...CPMM_SHARED_FIELDS, id: entry.id, index: entry.index, tradeFeeRate: entry.tradeFeeRate, creatorFeeRate: entry.creatorFeeRate };
}

// Same nearest-tier reasoning as pickAmmConfig — CPMM fee configs are just
// as admin-gated on-chain, so this snaps to the closest one Raydium
// actually publishes rather than pretending an exact rate is possible.
export function pickCpmmConfig(totalFeePercent) {
  const configs = CLUSTER === 'mainnet-beta' ? MAINNET_CPMM_CONFIGS : DEVNET_CPMM_CONFIGS;
  if (!totalFeePercent || totalFeePercent <= 0) {
    return toCpmmConfig(configs.find((c) => c.tradeFeeRate === 2500) ?? configs[0]);
  }
  const targetRate = totalFeePercent * 10000;
  const closest = configs.reduce((best, c) =>
    Math.abs(c.tradeFeeRate - targetRate) < Math.abs(best.tradeFeeRate - targetRate) ? c : best
  );
  return toCpmmConfig(closest);
}

export const COIN_DECIMALS = 6;
export const TOTAL_SUPPLY_WHOLE = 1_000_000_000n;

// Launch fee, paid by the creator directly to the platform wallet in a
// single transfer *before* the platform mints anything. Sized off real
// measured costs (see docs/token-launch-plan.md "Anti-spam fee") — mint is
// nearly free, pool creation is the real cost, with a safety margin so the
// platform never operates at a loss on rent-price drift.
//
// Under the pre-market/graduation model (see docs/token-launch-plan.md
// "Graduation") the platform's real cost is split across two very
// different times: createPreMarketPool happens right now, once, regardless
// of how many backing assets the creator picked — but createCpmmPoolAndLock
// happens later, at graduation, once *per* backing asset, on the
// platform's own wallet with no one left to charge at that point. Folding
// assetCount * MEASURED_GRADUATION_PER_ASSET_LAMPORTS into the fee here
// prefunds that future cost up front, the same anti-spam-not-revenue
// principle as before, just accounting for cost that lands later instead
// of assuming it's zero because it isn't paid immediately.
const MEASURED_MINT_LAMPORTS = 2_575_000; // ~0.0026 SOL observed
const MEASURED_PREMARKET_POOL_LAMPORTS = 168_572_000; // ~0.1686 SOL observed, createPreMarketPool (one-time, any assetCount)
const MEASURED_GRADUATION_PER_ASSET_LAMPORTS = 200_513_000; // ~0.2005 SOL observed, createCpmmPoolAndLock, per backing asset
const FEE_SAFETY_MARGIN = 1.15; // +15% buffer over the raw measured cost

export function calculateLaunchFeeLamports(assetCount) {
  const raw = MEASURED_MINT_LAMPORTS + MEASURED_PREMARKET_POOL_LAMPORTS + assetCount * MEASURED_GRADUATION_PER_ASSET_LAMPORTS;
  return Math.ceil(raw * FEE_SAFETY_MARGIN);
}

let connectionSingleton;
let payerSingleton;
let raydiumSingleton;

export function getConnection() {
  if (!connectionSingleton) {
    connectionSingleton = new Connection(RPC_URL, 'confirmed');
  }
  return connectionSingleton;
}

// PLATFORM_WALLET_SECRET arrives as either a JSON byte-array string (the
// shape a secrets manager would inject, and how devnet-wallet.json is
// still stored) or a base58 string (what a wallet like Phantom exports,
// and the shape actually pasted into Railway for the real platform key) —
// detected rather than assumed, since both are legitimate.
function parseSecretKey(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return Uint8Array.from(JSON.parse(trimmed));
  return bs58.decode(trimmed);
}

// The platform sponsors every launch — this keypair pays rent, fees, and
// supplies the single-sided COIN liquidity itself. `creatorWallet` is still
// required and recorded (see launch.mjs), but only for attribution; it never
// signs anything.
//
// Key loading prefers PLATFORM_WALLET_SECRET over the plaintext
// devnet-wallet.json file, so a real deploy never needs that file on disk —
// see docs/token-launch-plan.md "Fee payer" for why this still isn't full
// KMS/HSM custody (the Raydium SDK needs a local signer for `.execute()`).
export function getPlatformWallet() {
  if (!payerSingleton) {
    const fromEnv = process.env.PLATFORM_WALLET_SECRET;
    const secret = fromEnv
      ? parseSecretKey(fromEnv)
      : Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'devnet-wallet.json'))));
    payerSingleton = Keypair.fromSecretKey(secret);
  }
  return payerSingleton;
}

async function getRaydium() {
  if (!raydiumSingleton) {
    raydiumSingleton = await Raydium.load({
      connection: getConnection(),
      owner: getPlatformWallet(),
      cluster: CLUSTER,
    });
  }
  return raydiumSingleton;
}

function toApiV3Token(mint, decimals, symbol) {
  return {
    chainId: 103,
    address: mint,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    logoURI: '',
    symbol,
    name: symbol,
    decimals,
    tags: [],
    extensions: {},
  };
}

// Builds the launch fee transfer (real cost + margin, see
// calculateLaunchFeeLamports): creator -> platform, feePayer = creator.
// A plain SystemProgram.transfer needs no ephemeral signers, so nothing is
// pre-signed here — the creator's wallet is the only required signature.
export async function buildFeeTx(creatorWallet, lamports) {
  const connection = getConnection();
  const creator = new PublicKey(creatorWallet);
  const platform = getPlatformWallet().publicKey;

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: creator, toPubkey: platform, lamports })
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = creator;

  return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
}

// Broadcasts any already-signed transaction (legacy or versioned — raw wire
// bytes either way) and confirms it landed. Used for the fee transfer and
// both First Buy hops. Successful confirmation of a transfer/swap is itself
// the proof the wallet that's supposed to sign it did — Solana rejects a
// transaction missing a required signature, so there's nothing further to
// verify.
export async function broadcastSignedTx(signedTxBase64, label) {
  const connection = getConnection();
  const raw = Buffer.from(signedTxBase64, 'base64');
  const txId = await connection.sendRawTransaction(raw, { skipPreflight: false });

  for (let attempt = 0; attempt < 30; attempt++) {
    const { value } = await connection.getSignatureStatuses([txId]);
    const status = value[0];
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      if (status.err) throw new Error(`${label} failed: ` + JSON.stringify(status.err));
      return txId;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} confirmation timed out: ` + txId);
}

export function broadcastFeeTx(signedTxBase64) {
  return broadcastSignedTx(signedTxBase64, 'fee transaction');
}

// Mints the coin, platform wallet pays rent + holds the full initial supply
// until it's distributed into a pool by createPreMarketPool (and, later,
// createCpmmPoolAndLock at graduation). Also creates
// its on-chain Metaplex metadata (name/symbol/uri — without this, wallets
// and explorers show the coin as an unnamed token) and immediately locks
// down both authorities a launch platform shouldn't be trusted to hold
// indefinitely:
//   - freeze authority: never granted in the first place (null from
//     createInitializeMint2Instruction below) — nothing to revoke.
//   - metadata update authority: briefly held (has to be, to create the
//     metadata account at all) and cleared to null in the same
//     transaction, alongside locking isMutable false — see the comment
//     right above that instruction for why both happen in one call.
//   - mint authority: *is* needed up front (to mint the initial supply in
//     this same transaction) and revoked at the end of it — supply is
//     fixed at TOTAL_SUPPLY_WHOLE forever after this transaction confirms.
// All of it — create, initialize, ATA, mint, metadata, revoke — happens as
// one transaction, so there's no window where a partial failure could
// leave the mint authority live with only some of these done.
export async function mintCoinToken({ name, symbol, metadataUri }) {
  const connection = getConnection();
  const payer = getPlatformWallet();
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey);
  const totalAtomic = TOTAL_SUPPLY_WHOLE * 10n ** BigInt(COIN_DECIMALS);

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );

  const rentLamports = await getMinimumBalanceForRentExemptMint(connection);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: MINT_SIZE,
      lamports: rentLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint, COIN_DECIMALS, payer.publicKey, null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer.publicKey, totalAtomic, [], TOKEN_PROGRAM_ID),
    // Created mutable, then immediately locked by the update instruction
    // right below — has to be this order. The on-chain program rejects any
    // update once is_mutable is false, including the update that would
    // clear updateAuthority itself, so nulling the authority and locking
    // immutability must happen together, in the one update call made while
    // it's still mutable.
    createCreateMetadataAccountV3Instruction(
      { metadata: metadataPda, mint, mintAuthority: payer.publicKey, payer: payer.publicKey, updateAuthority: payer.publicKey },
      {
        createMetadataAccountArgsV3: {
          data: { name, symbol, uri: metadataUri, sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null },
          isMutable: true,
          collectionDetails: null,
        },
      }
    ),
    // On-chain, a metadata account's updateAuthority is a plain 32-byte
    // pubkey field, not an optional one — there's no "empty" value for it.
    // Passing `null` here (tried first) doesn't clear it; for this
    // instruction's args, None on a field means "leave unchanged", so
    // `updateAuthority: null` silently kept the platform's key in place
    // (confirmed by decoding a real launch's metadata after — isMutable
    // did flip to false, updateAuthority didn't move). The actual
    // convention for "no one controls this" is reassigning it to the
    // System Program's address, which is a valid pubkey that can never
    // sign a transaction as an authority.
    createUpdateMetadataAccountV2Instruction(
      { metadata: metadataPda, updateAuthority: payer.publicKey },
      { updateMetadataAccountArgsV2: { data: null, updateAuthority: SystemProgram.programId, primarySaleHappened: null, isMutable: false } }
    ),
    createSetAuthorityInstruction(mint, payer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID)
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair]);

  return { mint: mint.toBase58(), ata: ata.toBase58(), metadata: metadataPda.toBase58() };
}

// Pre-market pool: a single-sided COIN/SOL position sized (see
// calibration.mjs calibratePreMarketPool) so that fully depleting it raises
// ~85 SOL — pump.fun's own graduation target, replicated here so a launch
// feels the same to trade against even though the mechanics underneath
// (a real CLMM range, not a virtual-reserve curve) are different.
//
// Deliberately left *unlocked*, unlike the final CPMM pools graduation
// creates (createCpmmPoolAndLock) — graduation (see closePreMarketPool
// below) has to be able to close
// this position and withdraw the real SOL it collected, which Raydium's
// Lock CL Position program exists specifically to make impossible. The
// position NFT sits in the platform wallet's own ATA in the meantime, the
// same custody model the platform already has over every other step of a
// launch before anything gets locked.
//
// Real Raydium pool from the moment this lands on-chain, so anyone can
// already trade against it directly (Raydium's own UI, Jupiter once it's
// indexed) — no separate buy/sell path needed on top of this.
export async function createPreMarketPool({ coinMint }) {
  const raydium = await getRaydium();
  const connection = getConnection();
  const coinIsMintA = isCoinMintA(coinMint, SOL_MINT);

  const ammConfig = pickAmmConfig(0); // fee rate doesn't matter here — this position isn't locked, so any accrued fees come back automatically when it's closed at graduation, not harvested separately.

  const { tickLower, tickUpper, base, startPrice, coinShareAtomic } = calibratePreMarketPool({
    coinIsMintA,
    coinDecimals: COIN_DECIMALS,
    solDecimals: 9,
    tickSpacing: ammConfig.tickSpacing,
  });

  const coinToken = toApiV3Token(coinMint, COIN_DECIMALS, 'COIN');
  const solToken = toApiV3Token(SOL_MINT, 9, 'SOL');

  const { execute: executeCreate, extInfo: createExtInfo } = await raydium.clmm.createCustomizablePool({
    programId: CLMM_PROGRAM_ID_FOR_CLUSTER,
    mint1: coinIsMintA ? coinToken : solToken,
    mint2: coinIsMintA ? solToken : coinToken,
    ammConfig,
    initialPrice: startPrice,
    collectFeeOnMint: new PublicKey(SOL_MINT),
    txVersion: TxVersion.V0,
  });
  const createResult = await executeCreate({ sendAndConfirm: true });

  const mockPoolInfo = createExtInfo.mockPoolInfo;
  const poolKeys = createExtInfo.address;
  const rawPoolId = poolKeys.id ?? poolKeys.poolId;
  const poolId = typeof rawPoolId === 'string' ? rawPoolId : rawPoolId.toBase58();

  const { execute: executeOpen, extInfo: openExtInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo: mockPoolInfo,
    poolKeys,
    ownerInfo: { useSOLBalance: true },
    tickLower,
    tickUpper,
    base,
    baseAmount: coinShareAtomic,
    // Should be 0 for a genuinely single-sided position, but fixed-point
    // sqrt-price rounding can require a few atomic units on the "other"
    // side depending on price magnitude — a small buffer costs nothing
    // economically and absorbs the rounding.
    otherAmountMax: new BN(1000),
    txVersion: TxVersion.V0,
  });
  const openResult = await executeOpen({ sendAndConfirm: true });
  const positionNftMint = openExtInfo.nftMint;

  return {
    poolId,
    positionNftMint: positionNftMint.toBase58(),
    tickLower,
    tickUpper,
    startPrice: startPrice.toString(),
    createTx: createResult?.txId ?? String(createResult),
    openTx: openResult?.txId ?? String(openResult),
  };
}

// Whether a pre-market pool has been fully swept to its ceiling tick — the
// depletion-detection cron's trigger to graduate. calibratePreMarketPool
// always puts the *anchor* tick (where the position started, 100% COIN) at
// tickLower when coinIsMintA and tickUpper otherwise (see its own comment:
// "narrow/wide ... solAtDepletion increases monotonically moving away from
// anchorTick"), so the ceiling — the edge the position converts entirely
// to SOL at — is always the *other* boundary. coinIsMintA is recomputed
// here rather than stored: isCoinMintA(coinMint, SOL_MINT) is a pure
// function of two pubkeys, so it's always safe to derive fresh instead of
// trusting a persisted flag to still match.
// Split out so pool-watcher.mjs's account-change subscription can reuse the
// exact same comparison against the raw account bytes a WebSocket push
// already hands it, instead of spending a second RPC round-trip re-fetching
// what it was just sent.
export function isPoolDataDepleted(accountData, { tickLower, tickUpper, coinMint }) {
  const poolState = PoolInfoLayout.decode(accountData);
  const coinIsMintA = isCoinMintA(coinMint, SOL_MINT);
  return coinIsMintA ? poolState.tickCurrent >= tickUpper : poolState.tickCurrent <= tickLower;
}

export async function isPreMarketPoolDepleted({ poolAddress, tickLower, tickUpper, coinMint }) {
  const connection = getConnection();
  const poolAccountInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
  if (!poolAccountInfo) {
    throw new Error(`pool account not found for ${poolAddress} on ${CLUSTER} — likely a stale row from a different cluster`);
  }
  return isPoolDataDepleted(poolAccountInfo.data, { tickLower, tickUpper, coinMint });
}

// Graduation's other half: withdraws 100% of a pre-market position's
// current liquidity in one call (decreaseLiquidity with closePosition:
// true also reclaims the position account's rent) and returns exactly how
// much SOL and COIN came back, by diffing the platform's own balances
// around the call rather than trusting a computed estimate — same
// diff-the-real-balance approach harvestPoolFees already uses for CLMM
// fee collection. Works whether the position is genuinely fully depleted
// (the real graduation case — comes back ~100% SOL) or only partially
// swept (accrued trading fees come back too either way, since this
// position was deliberately never locked).
export async function closePreMarketPool({ poolId, positionNftMint, coinMint }) {
  const raydium = await getRaydium();
  const connection = getConnection();
  const payer = getPlatformWallet();

  const solBalanceBefore = await connection.getBalance(payer.publicKey);
  const coinBalanceBefore = await getTokenBalance(payer.publicKey.toBase58(), coinMint);

  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
  const positionPda = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID_FOR_CLUSTER, new PublicKey(positionNftMint)).publicKey;
  const positionAccountInfo = await connection.getAccountInfo(positionPda);
  const ownerPosition = PersonalPositionLayout.decode(positionAccountInfo.data);

  const { execute } = await raydium.clmm.decreaseLiquidity({
    poolInfo,
    poolKeys,
    ownerPosition,
    ownerInfo: { useSOLBalance: true, closePosition: true },
    liquidity: ownerPosition.liquidity,
    amountMinA: new BN(0),
    amountMinB: new BN(0),
    txVersion: TxVersion.V0,
  });
  const result = await execute({ sendAndConfirm: true });

  // Rent reclaimed from closePosition also lands in the platform's SOL
  // balance, on top of whatever the position held — harmless to lump in
  // together here since it's a tiny, fixed amount (~0.002 SOL) next to a
  // graduation-sized withdrawal, and the caller only needs "how much did
  // I get back to work with," not a rent-exclusive figure.
  const solBalanceAfter = await connection.getBalance(payer.publicKey);
  const coinBalanceAfter = await getTokenBalance(payer.publicKey.toBase58(), coinMint);

  return {
    txId: result?.txId ?? String(result),
    solReceivedLamports: new BN(solBalanceAfter - solBalanceBefore),
    coinReceivedAtomic: coinBalanceAfter.sub(coinBalanceBefore),
  };
}

// Converts a share of the SOL graduation just raised into one backing
// asset — platform-signed and sent immediately, unlike buildFirstBuyTx's
// hop1 (which returns an unsigned tx for the *creator* to sign). Same
// Jupiter dependency and the same limitation: Jupiter has no devnet
// liquidity to route through, so this is mainnet-only in practice, exactly
// like First Buy's hop1 already is — not re-verified here since it's the
// identical, already-accepted gap (see launch.mjs prepareFirstBuyHop1).
export async function swapPlatformSolForAsset({ assetMint, amountInLamports }) {
  const payer = getPlatformWallet();
  const connection = getConnection();

  const quote = await getSwapQuote({ inputMint: SOL_MINT, outputMint: assetMint, amountLamports: amountInLamports.toString() });
  const txBase64 = await buildSwapTx({ quoteResponse: quote, userPublicKey: payer.publicKey.toBase58() });
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  tx.sign([payer]);
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction(sig, 'confirmed');

  return { txId: sig, amountOutAtomic: new BN(quote.outAmount) };
}

// A graduated token's real final pool: a standard two-sided Raydium AMM
// (CPMM), not CLMM — deliberately, so there's no tick range to calibrate a
// ceiling into (see calibratePreMarketPool's own comment and
// docs/token-launch-plan.md "Graduation"). Deposits real reserves on both
// sides — the COIN held back from the pre-market allocation, and whatever
// backing asset graduation bought with its share of the raised SOL — so
// there's no single-sided calibration needed here at all, just a normal
// dual-token liquidity add.
//
// Locked immediately via CPMM's own Lock LP program — the fungible-LP
// equivalent of CLMM's Lock CL Position program used for the pre-market
// pool's non-existent final-pool predecessor. Same guarantee: once locked,
// nobody (platform included) can withdraw the underlying liquidity:
// collectCreatorFees/harvestLockLp remain available for the reward model
// without that guarantee being at odds with fee collection.
export async function createCpmmPoolAndLock({ coinMint, assetMint, assetDecimals, coinAmountAtomic, assetAmountAtomic, totalRewardFeePercent }) {
  const raydium = await getRaydium();
  const connection = getConnection();
  const payer = getPlatformWallet();

  const feeConfig = pickCpmmConfig(totalRewardFeePercent);
  const coinToken = { address: coinMint, decimals: COIN_DECIMALS, programId: TOKEN_PROGRAM_ID.toBase58() };
  // Any real mint now (see launch.mjs assertAssets), not just the three
  // Hylo registry ones that happened to all be 6 decimals — the caller
  // already resolved and stored this at launch time, so it's passed in
  // rather than re-fetched here.
  const assetToken = { address: assetMint, decimals: assetDecimals, programId: TOKEN_PROGRAM_ID.toBase58() };
  const coinIsMintA = isCoinMintA(coinMint, assetMint);

  const { execute: executeCreate, extInfo: createExtInfo } = await raydium.cpmm.createPool({
    programId: CREATE_CPMM_POOL_PROGRAM_FOR_CLUSTER,
    poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC_FOR_CLUSTER,
    mintA: coinIsMintA ? coinToken : assetToken,
    mintB: coinIsMintA ? assetToken : coinToken,
    mintAAmount: coinIsMintA ? coinAmountAtomic : assetAmountAtomic,
    mintBAmount: coinIsMintA ? assetAmountAtomic : coinAmountAtomic,
    startTime: new BN(0),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });
  const createResult = await executeCreate({ sendAndConfirm: true });

  const poolId = createExtInfo.address.poolId.toBase58();
  const lpMint = createExtInfo.address.lpMint;
  const lpMintPk = lpMint.toBase58 ? lpMint : new PublicKey(lpMint);

  const lpAta = await getAssociatedTokenAddress(lpMintPk, payer.publicKey);
  const lpAccount = await getAccount(connection, lpAta);
  const lpAmount = new BN(lpAccount.amount.toString());

  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  const { execute: executeLock, extInfo: lockExtInfo } = await raydium.cpmm.lockLp({
    poolInfo,
    poolKeys,
    lpAmount,
    programId: LOCK_CPMM_PROGRAM_FOR_CLUSTER,
    authProgram: LOCK_CPMM_AUTH_FOR_CLUSTER,
    withMetadata: true,
    txVersion: TxVersion.V0,
  });
  const lockResult = await executeLock({ sendAndConfirm: true });

  return {
    poolId,
    lpMint: lpMintPk.toBase58(),
    lockNftMint: lockExtInfo.nftMint.toBase58(),
    createTx: createResult?.txId ?? String(createResult),
    lockTx: lockResult?.txId ?? String(lockResult),
  };
}

// Reads a wallet's real atomic-unit balance of `mint` — used to size First
// Buy's second hop off what the SOL->asset swap actually delivered, instead
// of trusting a pre-swap quote estimate that could drift from the real
// on-chain result.
export async function getTokenBalance(ownerWallet, mint) {
  const connection = getConnection();
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(ownerWallet));
  try {
    const account = await getAccount(connection, ata);
    return new BN(account.amount.toString());
  } catch {
    return new BN(0);
  }
}

// Any real classic-SPL mint can be a backing asset now (see launch.mjs
// assertAssets), not just the three Hylo registry ones whose decimals used
// to be a hardcoded, known-safe 6 — this reads the real value off the mint
// account instead of assuming. Throws on anything that isn't a real mint
// on this cluster, which assertAssets relies on to reject a bad address
// before the creator ever pays the launch fee.
//
// Deliberately rejects Token-2022 mints too, rather than silently
// accepting one that would fail confusingly much later: this file assumes
// TOKEN_PROGRAM_ID (the classic token program) throughout — ATA
// derivation for reward payouts (sendTokenBatch), swaps
// (swapPlatformCpmm/swapPlatformSolForAsset), and pool creation
// (createCpmmPoolAndLock) all do — and making the entire payout/swap/pool
// pipeline Token-2022-aware is real, untested scope beyond just reading a
// decimals value. Failing clearly here, at launch validation time, beats
// failing unclearly during graduation or a reward run months later.
export async function getMintDecimals(mintAddress) {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mintAddress);
  const accountInfo = await connection.getAccountInfo(mintPubkey);
  if (!accountInfo) throw new Error(`no account found at ${mintAddress}`);
  if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`${mintAddress} is a Token-2022 mint — not supported as a backing asset yet, only classic SPL tokens`);
  }
  const info = await getMint(connection, mintPubkey);
  return info.decimals;
}

// Second hop of First Buy: swap `amountIn` atomic units of the backing
// asset for COIN, through the pool this launch already created. Built with
// owner = the creator's bare PublicKey (no signing capability here), so it
// comes back unsigned for them to sign themselves — the resulting COIN
// lands directly in their own wallet, never the platform's. Follows
// Raydium's own documented pattern for a single CLMM swap (getSwapPoolInfo
// + swapInternal simulation for remainingAccounts/amountOutMin, then
// clmm.swap) — see raydium-sdk-V2-demo/src/clmm/swap.ts.
export async function buildFirstBuyTx({ poolId, coinMint, assetMint, buyerWallet, amountIn }) {
  const connection = getConnection();
  const buyer = new PublicKey(buyerWallet);
  const raydium = await Raydium.load({ connection, owner: buyer, cluster: CLUSTER });

  // Selling the backing asset for COIN: zeroForOne is "selling mintA for
  // mintB", so it's true when COIN is mintB (we're spending mintA), false
  // when COIN is mintA (we're spending mintB) — same mintA/mintB ordering
  // rule used when the pool was created (calibration.mjs isCoinMintA).
  const coinIsMintA = isCoinMintA(coinMint, assetMint);
  const zeroForOne = !coinIsMintA;

  const { poolInfo, rpcData, configInfo, tickArrays } = await raydium.clmm.getSwapPoolInfo(poolId, zeroForOne);
  const programId = new PublicKey(poolInfo.programId);
  const poolIdPub = new PublicKey(poolInfo.id);

  const bitmapExtensionAddr = getPdaExBitmapAccount(programId, poolIdPub).publicKey;
  const bitmapExtensionAccount = await connection.getAccountInfo(bitmapExtensionAddr);
  const tickarrayBitmapExtension = TickArrayBitmapExtensionLayout.decode(bitmapExtensionAccount.data);

  const simulation = swapInternal({
    programId,
    poolId: poolIdPub,
    poolInfo: rpcData,
    tickArrays,
    configInfo,
    tickarrayBitmapExtension,
    amountSpecified: amountIn,
    sqrtPriceLimitX64: new BN(0),
    zeroForOne,
    isBaseInput: true,
    blockTimestamp: Math.floor(Date.now() / 1000),
    includeExtraTickArrays: true,
  });

  // 1% slippage buffer under the simulated output — real execution price
  // can drift slightly between simulation and confirmation.
  const amountOutMin = simulation.amountCalculated.muln(99).divn(100);
  const inputMint = zeroForOne ? poolInfo.mintA.address : poolInfo.mintB.address;

  const { transaction, signers } = await raydium.clmm.swap({
    poolInfo,
    inputMint,
    amountIn,
    amountOutMin,
    observationId: rpcData.observationId,
    ownerInfo: { useSOLBalance: true },
    remainingAccounts: simulation.accounts,
    txVersion: TxVersion.V0,
    feePayer: buyer,
  });

  if (signers.length) transaction.sign(signers);
  return {
    txBase64: Buffer.from(transaction.serialize()).toString('base64'),
    // The simulation's own output estimate — precise (reflects this pool's
    // real current price/liquidity), unlike any pre-swap guess. Callers use
    // this to enforce a supply cap before ever handing back a signable tx.
    coinAmountOut: simulation.amountCalculated.toString(),
  };
}

// CPMM's locked-LP fee accounting doesn't live in a plain RPC-decodable
// account the way CLMM's tick-based position fees did — there's no exported
// on-chain layout for the lock account in the SDK, and harvestLockLp takes
// an explicit lpFeeAmount input rather than "harvest whatever's pending"
// (see docs/token-launch-plan.md "Reward cron: CPMM"). Raydium's own hosted
// indexer is the only source for this figure (it's what their own UI's
// claim-fees button uses too), reached directly rather than through the
// SDK's own raydium.api.fetchCpmmLockInfo — that helper mis-concatenates
// the base API host in front of CPMM_LOCK's already-absolute URL, a real
// bug confirmed by a raw request against it, not assumed. Empirically
// confirmed on devnet: the indexer can lag a real swap's fee by tens of
// seconds before it shows up — callers should tolerate a stale/zero read,
// not treat it as "nothing pending yet" being final.
async function fetchCpmmLockPosition(lockNftMint) {
  const lockPda = getCpLockPda(LOCK_CPMM_PROGRAM_FOR_CLUSTER, new PublicKey(lockNftMint)).publicKey;
  const base = CLUSTER === 'mainnet-beta' ? 'https://dynamic-ipfs.raydium.io' : 'https://dynamic-ipfs-devnet.raydium.io';
  const res = await fetch(`${base}/lock/cpmm/position?id=${lockPda.toBase58()}`);
  if (!res.ok) {
    throw new Error(`CPMM lock position lookup failed for ${lockPda.toBase58()}: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body?.positionInfo?.unclaimedFee || !body?.poolInfo) {
    throw new Error(`CPMM lock position lookup for ${lockPda.toBase58()} returned no positionInfo/unclaimedFee`);
  }
  return body;
}

// Pending (unharvested) fee estimate for a locked CPMM position, in atomic
// units of both pool sides — lets the reward cron check whether a token's
// accrued fees have crossed the USD threshold before spending a real
// transaction to collect them, same purpose the old CLMM getPoolPendingFees
// served. Unlike that one, this can't avoid the network round trip to
// Raydium's indexer (see fetchCpmmLockPosition) — there's no cheaper
// on-chain-only path for CPMM's locked-LP fee accounting.
export async function getCpmmPoolPendingFees({ lockNftMint }) {
  const info = await fetchCpmmLockPosition(lockNftMint);
  const { mintA, mintB, lpMint } = info.poolInfo;
  return {
    mintA: mintA.address,
    mintB: mintB.address,
    // "B per A" — same convention as poolPrice everywhere else in this file.
    priceBPerA: info.poolInfo.price,
    lpFeeAmount: new BN(Math.round(info.positionInfo.unclaimedFee.lp * 10 ** lpMint.decimals)),
    amountAAtomic: new BN(Math.round(info.positionInfo.unclaimedFee.amountA * 10 ** mintA.decimals)),
    amountBAtomic: new BN(Math.round(info.positionInfo.unclaimedFee.amountB * 10 ** mintB.decimals)),
  };
}

// Collects a locked CPMM position's accrued LP trading fees into the
// platform's own ATAs for both pool sides (CPMM fees accrue proportionally
// across both tokens, unlike CLMM's single-mint-pinned collectFeeOnMint —
// see docs/token-launch-plan.md "Reward cron: CPMM"). Re-reads pending fees
// itself right before harvesting rather than trusting an earlier read (the
// two calls may be minutes apart in the cron flow, and the indexer's own
// number can still be moving). Returns exact harvested amounts by diffing
// the platform's real balances around the call, same pattern as every other
// harvest/close function in this file.
export async function harvestCpmmLockedFees({ poolId, lockNftMint, coinMint, assetMint }) {
  const payer = getPlatformWallet();
  const raydium = await getRaydium();

  const pending = await getCpmmPoolPendingFees({ lockNftMint });
  if (pending.lpFeeAmount.isZero()) {
    throw new Error(`no pending CPMM fee to harvest for lock ${lockNftMint} — check before calling`);
  }

  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  const coinBalanceBefore = await getTokenBalance(payer.publicKey.toBase58(), coinMint);
  const assetBalanceBefore = await getTokenBalance(payer.publicKey.toBase58(), assetMint);

  const { execute } = await raydium.cpmm.harvestLockLp({
    poolInfo,
    poolKeys,
    nftMint: new PublicKey(lockNftMint),
    lpFeeAmount: pending.lpFeeAmount,
    // Without programId/authProgram, harvestLockLp defaults to its own
    // top-level mainnet LOCK_CPMM_PROGRAM/LOCK_CPMM_AUTH constants
    // regardless of CLUSTER — caught for real on devnet as a raw
    // "InvalidProgramForExecution" runtime error (not even a proper Error
    // instance, just a string with a txId attached). Without cpmmProgram,
    // it separately defaults the *pool's own* program/authority to their
    // mainnet constants too — caught for real as a second, distinct
    // failure (AnchorError InvalidProgramId, "Program ID was not as
    // expected", read straight from the failed tx's on-chain logs) even
    // after the first fix. Neither default is documented; both were found
    // by reading the SDK's own instruction-building code, not assumed.
    programId: LOCK_CPMM_PROGRAM_FOR_CLUSTER,
    authProgram: LOCK_CPMM_AUTH_FOR_CLUSTER,
    cpmmProgram: { programId: CREATE_CPMM_POOL_PROGRAM_FOR_CLUSTER, authProgram: CPMM_POOL_AUTHORITY_FOR_CLUSTER },
    txVersion: TxVersion.V0,
  });
  const result = await execute({ sendAndConfirm: true });

  const coinBalanceAfter = await getTokenBalance(payer.publicKey.toBase58(), coinMint);
  const assetBalanceAfter = await getTokenBalance(payer.publicKey.toBase58(), assetMint);
  return {
    txId: result?.txId ?? String(result),
    coinHarvestedAtomic: coinBalanceAfter.sub(coinBalanceBefore),
    assetHarvestedAtomic: assetBalanceAfter.sub(assetBalanceBefore),
  };
}

// Sends `amountAtomic` of `mint` to each recipient from the platform's own
// balance, creating their ATA first if they don't have one (the recipient
// never pays for their own account — see docs/token-launch-plan.md). Batches
// several recipients per transaction (idempotent-create + transfer per
// recipient) to keep the number of transactions down; batch size is
// conservative and verified against real transaction size limits on devnet,
// not just estimated.
const RECIPIENTS_PER_BATCH = 8;

export async function sendTokenBatch(mint, recipients) {
  const connection = getConnection();
  const payer = getPlatformWallet();
  const mintPubkey = new PublicKey(mint);
  const fromAta = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);

  const results = [];
  for (let i = 0; i < recipients.length; i += RECIPIENTS_PER_BATCH) {
    const batch = recipients.slice(i, i + RECIPIENTS_PER_BATCH);
    const tx = new Transaction();
    for (const { wallet, amountAtomic } of batch) {
      const owner = new PublicKey(wallet);
      const toAta = await getAssociatedTokenAddress(mintPubkey, owner);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, owner, mintPubkey));
      tx.add(createTransferInstruction(fromAta, toAta, payer.publicKey, BigInt(amountAtomic.toString())));
    }
    const txId = await sendAndConfirmTransaction(connection, tx, [payer]);
    for (const r of batch) results.push({ wallet: r.wallet, amountAtomic: r.amountAtomic, txId });
  }
  return results;
}

// Platform-signed swap through one of a token's own final CPMM pools —
// generic over direction (used both ways by the reward cron: backing-asset
// -> COIN for Buyback & Burn, and COIN -> backing-asset to convert a CPMM
// harvest's COIN-side fee into the same currency as its asset-side fee
// before the reward-model split runs — see rewards.mjs). Never creator- or
// user-signed, unlike buildFirstBuyTx; sent immediately rather than handed
// back unsigned. Returns the exact output amount received.
export async function swapPlatformCpmm({ poolId, inputMint, outputMint, amountInAtomic }) {
  const raydium = await getRaydium();
  const { poolInfo, poolKeys, computePoolInfo } = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  const quote = raydium.cpmm.computeSwapAmount({
    pool: computePoolInfo,
    amountIn: amountInAtomic,
    outputMint,
    slippage: 0.05,
  });
  const baseIn = poolInfo.mintA.address === inputMint;

  const { execute } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    inputAmount: amountInAtomic,
    swapResult: quote.swapResult,
    slippage: 0.05,
    baseIn,
    txVersion: TxVersion.V0,
  });
  const result = await execute({ sendAndConfirm: true });

  return { txId: result?.txId ?? String(result), amountOutAtomic: quote.swapResult.outputAmount };
}

// Burns `amountAtomic` of COIN from the platform's own ATA — the second
// half of Buyback & Burn, permanently reducing supply. Requires no
// authority beyond the platform's own signature (burning your own tokens
// needs no special permission).
export async function burnCoin(coinMint, amountAtomic) {
  const connection = getConnection();
  const payer = getPlatformWallet();
  const mintPubkey = new PublicKey(coinMint);
  const ata = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);

  const tx = new Transaction().add(
    createBurnInstruction(ata, mintPubkey, payer.publicKey, BigInt(amountAtomic.toString()))
  );
  const txId = await sendAndConfirmTransaction(connection, tx, [payer]);
  return { txId };
}
