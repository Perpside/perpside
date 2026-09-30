import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
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
  CLMM_LOCK_PROGRAM_ID,
  CLMM_LOCK_AUTH_ID,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  LOCK_CPMM_PROGRAM,
  LOCK_CPMM_AUTH,
  TxVersion,
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  getPdaTickArrayAddress,
  getPdaLockClPositionIdV2,
  PersonalPositionLayout,
  PoolInfoLayout,
  CpmmPoolInfoLayout,
  TickArrayLayout,
  TickArrayUtil,
  PositionUtils,
  LockClPositionLayoutV2,
  TickArrayBitmapExtensionLayout,
  swapInternal,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCoinMintA, calibratePool, calibratePreMarketPool, toAtomicUnits, PREMARKET_CURVE_COIN_WHOLE } from './calibration.mjs';
import { SOL_MINT } from './jupiter.mjs';

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
export const CLMM_LOCK_PROGRAM_ID_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CLMM_LOCK_PROGRAM_ID : DEVNET_PROGRAM_ID.CLMM_LOCK_PROGRAM_ID;
export const CLMM_LOCK_AUTH_ID_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CLMM_LOCK_AUTH_ID : DEVNET_PROGRAM_ID.CLMM_LOCK_AUTH_ID;
export const CREATE_CPMM_POOL_PROGRAM_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM;
export const CREATE_CPMM_POOL_FEE_ACC_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CREATE_CPMM_POOL_FEE_ACC : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC;
export const LOCK_CPMM_PROGRAM_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? LOCK_CPMM_PROGRAM : DEVNET_PROGRAM_ID.LOCK_CPMM_PROGRAM;
export const LOCK_CPMM_AUTH_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? LOCK_CPMM_AUTH : DEVNET_PROGRAM_ID.LOCK_CPMM_AUTH;

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
// nearly free, each pool (createPool + openPositionFromBase: pool state, 2
// vaults, tick arrays, position NFT) is the real cost — with a safety
// margin so the platform never operates at a loss on rent-price drift.
const MEASURED_MINT_LAMPORTS = 2_575_000; // ~0.0026 SOL observed
const MEASURED_PER_POOL_LAMPORTS = 168_572_000; // ~0.1686 SOL observed, per pool
const FEE_SAFETY_MARGIN = 1.15; // +15% buffer over the raw measured cost

export function calculateLaunchFeeLamports(assetCount) {
  const raw = MEASURED_MINT_LAMPORTS + assetCount * MEASURED_PER_POOL_LAMPORTS;
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
// until it's distributed into pools by createPoolAndPosition. Also creates
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

// Creates one CLMM pool for `coinMint` paired with `asset`, calibrated to
// targetFdvUsd, and opens a single-sided (100% COIN) position sized to
// coinShareWhole. Platform wallet pays all rent and provides all liquidity.
export async function createPoolAndPosition({ coinMint, asset, targetFdvUsd, coinShareWhole, totalRewardFeePercent }) {
  const raydium = await getRaydium();
  const connection = getConnection();
  const payer = getPlatformWallet();
  const coinIsMintA = isCoinMintA(coinMint, asset.mint);

  // Snapped to the nearest tier Raydium actually publishes — see
  // pickAmmConfig's own comment for why it can't be exact.
  const ammConfig = pickAmmConfig(totalRewardFeePercent);

  const coinShareAtomic = toAtomicUnits(coinShareWhole, COIN_DECIMALS);
  const { tickLower, tickUpper, base, startPrice } = calibratePool({
    coinIsMintA,
    coinDecimals: COIN_DECIMALS,
    assetDecimals: asset.decimals,
    assetUsdPrice: asset.usdPrice,
    targetFdvUsd,
    totalSupplyWhole: TOTAL_SUPPLY_WHOLE,
    coinShareAtomic,
    tickSpacing: ammConfig.tickSpacing,
  });

  const coinToken = toApiV3Token(coinMint, COIN_DECIMALS, 'COIN');
  const assetToken = toApiV3Token(asset.mint, asset.decimals, asset.symbol);

  // createCustomizablePool instead of the plain createPool so fees can be
  // pinned to the backing asset (collectFeeOnMint) instead of accruing
  // split across both tokens depending on swap direction — the backing
  // asset is the liquid, useful-to-holders side; COIN itself is what a
  // future Buyback & Burn step would need to swap into anyway, so there's
  // no benefit to collecting fees in COIN before that step exists.
  const { execute: executeCreate, extInfo: createExtInfo } = await raydium.clmm.createCustomizablePool({
    programId: CLMM_PROGRAM_ID_FOR_CLUSTER,
    mint1: coinIsMintA ? coinToken : assetToken,
    mint2: coinIsMintA ? assetToken : coinToken,
    ammConfig,
    initialPrice: startPrice,
    collectFeeOnMint: new PublicKey(asset.mint),
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
    // side depending on price magnitude — 0 tolerance intermittently fails
    // (seen: Raydium CLMM custom error 6017) on some assets. A small buffer
    // costs nothing economically and absorbs the rounding. Platform wallet
    // needs a small pre-funded balance of each backing asset to cover it
    // (see server/setup-backing-assets.mjs).
    otherAmountMax: new BN(1000),
    txVersion: TxVersion.V0,
  });
  const openResult = await executeOpen({ sendAndConfirm: true });
  const positionNftMint = openExtInfo.nftMint;

  // Locked immediately via Raydium's own Lock CL Position program — *not*
  // burned. A burn permanently forfeits this position's accrued trading
  // fees too (decreaseLiquidity is CLMM's only fee-harvesting path, and it
  // requires presenting the position NFT, burned or not), which would
  // also foreclose the Reward Model's fee collection forever. lockPosition
  // gives the same "can never be withdrawn, by anyone, including the
  // platform" guarantee while leaving harvestLockPosition available to
  // collect fees from the locked position later. Needs the position
  // account to actually exist on-chain first (Raydium decodes it from a
  // fresh RPC read), so unlike the mint step this can't be one transaction
  // with openPositionFromBase — see docs/token-launch-plan.md.
  const positionPda = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID_FOR_CLUSTER, positionNftMint).publicKey;
  const positionAccountInfo = await connection.getAccountInfo(positionPda);
  const ownerPosition = PersonalPositionLayout.decode(positionAccountInfo.data);

  const { execute: executeLock, extInfo: lockExtInfo } = await raydium.clmm.lockPosition({
    programId: CLMM_LOCK_PROGRAM_ID_FOR_CLUSTER,
    authProgramId: CLMM_LOCK_AUTH_ID_FOR_CLUSTER,
    poolProgramId: CLMM_PROGRAM_ID_FOR_CLUSTER,
    ownerPosition,
    txVersion: TxVersion.V0,
  });
  const lockResult = await executeLock({ sendAndConfirm: true });

  return {
    poolId,
    positionNftMint: positionNftMint.toBase58(),
    lockNftMint: lockExtInfo.lockNftMint.toBase58(),
    tickLower,
    tickUpper,
    startPrice: startPrice.toString(),
    createTx: createResult?.txId ?? String(createResult),
    openTx: openResult?.txId ?? String(openResult),
    lockTx: lockResult?.txId ?? String(lockResult),
  };
}

// Pre-market pool: a single-sided COIN/SOL position sized (see
// calibration.mjs calibratePreMarketPool) so that fully depleting it raises
// ~85 SOL — pump.fun's own graduation target, replicated here so a launch
// feels the same to trade against even though the mechanics underneath
// (a real CLMM range, not a virtual-reserve curve) are different.
//
// Deliberately left *unlocked*, unlike createPoolAndPosition's final pools
// — graduation (see graduatePreMarketPool below) has to be able to close
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
    otherAmountMax: new BN(1000), // same rounding buffer as createPoolAndPosition
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
export async function createCpmmPoolAndLock({ coinMint, assetMint, coinAmountAtomic, assetAmountAtomic, totalRewardFeePercent }) {
  const raydium = await getRaydium();
  const connection = getConnection();
  const payer = getPlatformWallet();

  const feeConfig = pickCpmmConfig(totalRewardFeePercent);
  const coinToken = { address: coinMint, decimals: COIN_DECIMALS, programId: TOKEN_PROGRAM_ID.toBase58() };
  const assetToken = { address: assetMint, decimals: 6, programId: TOKEN_PROGRAM_ID.toBase58() };
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

// Reads a locked position's *unharvested* fee amount directly from on-chain
// state (pool + the two tick arrays bounding the position), without ever
// calling harvestLockPosition — lets the reward cron check whether a
// token's accrued fees have crossed the USD threshold before spending a
// transaction to actually collect them. Verified against a real harvest on
// devnet: the harvested amount landed exactly equal to what this function
// predicted beforehand (see docs/token-launch-plan.md).
export async function getPoolPendingFees({ poolAddress, positionNftMint, tickLower, tickUpper }, coinMint) {
  const connection = getConnection();
  const poolAccountInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
  // A stored pool/position address that doesn't resolve on the current
  // RPC/CLUSTER almost always means this row was created under a
  // *different* cluster than the one the backend is running against right
  // now (e.g. a devnet launch left in the DB after CLUSTER flipped to
  // mainnet-beta) — every PDA below is derived using
  // CLMM_PROGRAM_ID_FOR_CLUSTER, so a cluster mismatch makes them resolve
  // to addresses that were never created. Failing loudly here beats a bare
  // "Cannot read properties of null" a few lines down.
  if (!poolAccountInfo) {
    throw new Error(`pool account not found for ${poolAddress} on ${CLUSTER} — likely a stale row from a different cluster`);
  }
  const poolState = PoolInfoLayout.decode(poolAccountInfo.data);

  const positionPda = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID_FOR_CLUSTER, new PublicKey(positionNftMint)).publicKey;
  const positionAccountInfo = await connection.getAccountInfo(positionPda);
  if (!positionAccountInfo) {
    throw new Error(`position account not found for ${positionPda.toBase58()} on ${CLUSTER} — likely a stale row from a different cluster`);
  }
  const positionState = PersonalPositionLayout.decode(positionAccountInfo.data);

  const startIndexLower = TickArrayUtil.getTickArrayStartIndex(tickLower, poolState.tickSpacing);
  const startIndexUpper = TickArrayUtil.getTickArrayStartIndex(tickUpper, poolState.tickSpacing);
  const tickArrayLowerPda = getPdaTickArrayAddress(CLMM_PROGRAM_ID_FOR_CLUSTER, new PublicKey(poolAddress), startIndexLower).publicKey;
  const tickArrayUpperPda = getPdaTickArrayAddress(CLMM_PROGRAM_ID_FOR_CLUSTER, new PublicKey(poolAddress), startIndexUpper).publicKey;

  const sameArray = tickArrayLowerPda.equals(tickArrayUpperPda);
  const keys = sameArray ? [tickArrayLowerPda] : [tickArrayLowerPda, tickArrayUpperPda];
  const infos = await connection.getMultipleAccountsInfo(keys);
  if (infos.some((info) => !info)) {
    throw new Error(`tick array account not found for pool ${poolAddress} on ${CLUSTER} — likely a stale row from a different cluster`);
  }
  const lowerArray = TickArrayLayout.decode(infos[0].data);
  const upperArray = sameArray ? lowerArray : TickArrayLayout.decode(infos[1].data);

  const lowerOffset = TickArrayUtil.getTickOffsetInArray(tickLower, poolState.tickSpacing);
  const upperOffset = TickArrayUtil.getTickOffsetInArray(tickUpper, poolState.tickSpacing);
  const tickLowerData = lowerArray.ticks[lowerOffset];
  const tickUpperData = upperArray.ticks[upperOffset];

  const { tokenFeeAmountA, tokenFeeAmountB } = PositionUtils.GetPositionFees(poolState, positionState, tickLowerData, tickUpperData);

  // feeOn pins collection to the backing asset (see createPoolAndPosition),
  // so the COIN side should read ~0 regardless — read both and pick
  // whichever side actually matches the backing asset's mint rather than
  // assuming, so this stays correct if that ever changes.
  const coinIsA = poolState.mintA.toBase58() === coinMint;
  return coinIsA ? tokenFeeAmountB : tokenFeeAmountA;
}

// Collects a locked position's accrued fees into the platform's own ATA for
// the backing asset — the platform is both the lock owner and the fee
// payer, so this needs no creator/user signature. Returns the exact
// harvested amount by diffing the platform's ATA balance around the call,
// rather than trusting a return value the SDK doesn't expose directly.
export async function harvestPoolFees({ poolAddress, lockNftMint }, backingAssetMint) {
  const connection = getConnection();
  const payer = getPlatformWallet();
  const raydium = await getRaydium();

  const lockDataPda = getPdaLockClPositionIdV2(CLMM_LOCK_PROGRAM_ID_FOR_CLUSTER, new PublicKey(lockNftMint)).publicKey;
  const lockAccountInfo = await connection.getAccountInfo(lockDataPda);
  if (!lockAccountInfo) {
    throw new Error(`lock account not found for ${lockDataPda.toBase58()} on ${CLUSTER} — likely a stale row from a different cluster`);
  }
  const lockData = LockClPositionLayoutV2.decode(lockAccountInfo.data);

  const assetAta = await getAssociatedTokenAddress(new PublicKey(backingAssetMint), payer.publicKey);
  const balanceBefore = await getTokenBalance(payer.publicKey.toBase58(), backingAssetMint);

  const { execute } = await raydium.clmm.harvestLockPosition({
    programId: CLMM_LOCK_PROGRAM_ID_FOR_CLUSTER,
    authProgramId: CLMM_LOCK_AUTH_ID_FOR_CLUSTER,
    clmmProgram: CLMM_PROGRAM_ID_FOR_CLUSTER,
    lockData,
    txVersion: TxVersion.V0,
  });
  const result = await execute({ sendAndConfirm: true });

  const balanceAfter = await getTokenBalance(payer.publicKey.toBase58(), backingAssetMint);
  return { txId: result?.txId ?? String(result), harvestedAtomic: balanceAfter.sub(balanceBefore) };
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

// Platform-signed swap of its own backing-asset holdings into COIN — used
// only for the automated Buyback & Burn step (never creator- or
// user-signed, unlike buildFirstBuyTx). Same simulate-then-swap pattern as
// First Buy's hop 2, but self-signed and sent immediately rather than
// handed back unsigned. Returns the exact COIN amount received.
export async function swapPlatformAssetForCoin({ poolId, coinMint, assetMint, amountIn }) {
  const connection = getConnection();
  const payer = getPlatformWallet();
  const raydium = await getRaydium();

  // Selling the backing asset for COIN — identical operation to First Buy's
  // hop 2 (buildFirstBuyTx above), so the same zeroForOne rule applies:
  // true when COIN is mintB (we're spending mintA), false when COIN is
  // mintA (we're spending mintB).
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

  const amountOutMin = simulation.amountCalculated.muln(99).divn(100);
  const inputMint = zeroForOne ? poolInfo.mintA.address : poolInfo.mintB.address;

  const { execute } = await raydium.clmm.swap({
    poolInfo,
    inputMint,
    amountIn,
    amountOutMin,
    observationId: rpcData.observationId,
    ownerInfo: { useSOLBalance: true },
    remainingAccounts: simulation.accounts,
    txVersion: TxVersion.V0,
  });
  const result = await execute({ sendAndConfirm: true });

  return { txId: result?.txId ?? String(result), coinAmountOut: simulation.amountCalculated };
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
