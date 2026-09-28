import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createMint, mintTo, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Raydium, DEVNET_PROGRAM_ID, CLMM_PROGRAM_ID, TxVersion } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCoinMintA, calibratePool, toAtomicUnits } from './calibration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single switch for the whole backend: 'devnet' (default) or 'mainnet-beta'.
// Everything below (RPC, program IDs, AMM config) branches off this instead
// of hardcoding devnet — see docs/token-launch-plan.md "Rollout steps".
export const CLUSTER = process.env.CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
export const RPC_URL = process.env.RPC_URL || process.env.DEVNET_RPC_URL;
if (!RPC_URL) throw new Error('set RPC_URL (or the legacy DEVNET_RPC_URL) in .env');

export const CLMM_PROGRAM_ID_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CLMM_PROGRAM_ID : DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;

// Devnet 0.25%-fee CLMM config, fetched from api-v3-devnet.raydium.io/main/clmm-config.
const DEVNET_AMM_CONFIG = {
  id: new PublicKey('CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu'),
  index: 0,
  protocolFeeRate: 120000,
  tradeFeeRate: 2500,
  tickSpacing: 60,
  fundFeeRate: 40000,
  fundOwner: '',
  description: '',
};

// Mainnet equivalent (same 0.25% fee / tick-60 tier), fetched from Raydium's
// own public config API (api-v3.raydium.io/main/clmm-config) on 2026-09-29.
// Re-verify against that endpoint before relying on this in a real deploy —
// Raydium could reshuffle config indices.
const MAINNET_AMM_CONFIG = {
  id: new PublicKey('E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp'),
  index: 1,
  protocolFeeRate: 120000,
  tradeFeeRate: 2500,
  tickSpacing: 60,
  fundFeeRate: 40000,
  fundOwner: '',
  description: '',
};

export const AMM_CONFIG = CLUSTER === 'mainnet-beta' ? MAINNET_AMM_CONFIG : DEVNET_AMM_CONFIG;

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

// The platform sponsors every launch — this keypair pays rent, fees, and
// supplies the single-sided COIN liquidity itself. `creatorWallet` is still
// required and recorded (see launch.mjs), but only for attribution; it never
// signs anything.
//
// Key loading prefers PLATFORM_WALLET_SECRET (a JSON-array string, the shape
// a secrets manager would inject at deploy time) over the plaintext
// devnet-wallet.json file, so a real deploy never needs that file on disk —
// see docs/token-launch-plan.md "Fee payer" for why this still isn't full
// KMS/HSM custody (the Raydium SDK needs a local signer for `.execute()`).
export function getPlatformWallet() {
  if (!payerSingleton) {
    const fromEnv = process.env.PLATFORM_WALLET_SECRET;
    const secret = fromEnv
      ? JSON.parse(fromEnv)
      : JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'devnet-wallet.json')));
    payerSingleton = Keypair.fromSecretKey(Uint8Array.from(secret));
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

// Broadcasts the creator-signed fee transaction and confirms it landed.
// Successful confirmation is itself the proof the creator's wallet signed it
// — Solana rejects a transfer instruction missing the source account's
// signature, so there's nothing further to verify.
export async function broadcastFeeTx(signedTxBase64) {
  const connection = getConnection();
  const raw = Buffer.from(signedTxBase64, 'base64');
  const txId = await connection.sendRawTransaction(raw, { skipPreflight: false });

  for (let attempt = 0; attempt < 30; attempt++) {
    const { value } = await connection.getSignatureStatuses([txId]);
    const status = value[0];
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      if (status.err) throw new Error('fee transaction failed: ' + JSON.stringify(status.err));
      return txId;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('fee transaction confirmation timed out: ' + txId);
}

// Mints the coin, platform wallet pays rent + holds the full initial supply
// until it's distributed into pools by createPoolAndPosition.
export async function mintCoinToken() {
  const connection = getConnection();
  const payer = getPlatformWallet();

  const mint = await createMint(connection, payer, payer.publicKey, null, COIN_DECIMALS);
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const totalAtomic = TOTAL_SUPPLY_WHOLE * 10n ** BigInt(COIN_DECIMALS);
  await mintTo(connection, payer, mint, ata.address, payer, totalAtomic);

  return { mint: mint.toBase58(), ata: ata.address.toBase58() };
}

// Creates one CLMM pool for `coinMint` paired with `asset`, calibrated to
// targetFdvUsd, and opens a single-sided (100% COIN) position sized to
// coinShareWhole. Platform wallet pays all rent and provides all liquidity.
export async function createPoolAndPosition({ coinMint, asset, targetFdvUsd, coinShareWhole }) {
  const raydium = await getRaydium();
  const coinIsMintA = isCoinMintA(coinMint, asset.mint);

  const coinShareAtomic = toAtomicUnits(coinShareWhole, COIN_DECIMALS);
  const { tickLower, tickUpper, base, startPrice } = calibratePool({
    coinIsMintA,
    coinDecimals: COIN_DECIMALS,
    assetDecimals: asset.decimals,
    assetUsdPrice: asset.usdPrice,
    targetFdvUsd,
    totalSupplyWhole: TOTAL_SUPPLY_WHOLE,
    coinShareAtomic,
    tickSpacing: AMM_CONFIG.tickSpacing,
  });

  const coinToken = toApiV3Token(coinMint, COIN_DECIMALS, 'COIN');
  const assetToken = toApiV3Token(asset.mint, asset.decimals, asset.symbol);

  const { execute: executeCreate, extInfo: createExtInfo } = await raydium.clmm.createPool({
    programId: CLMM_PROGRAM_ID_FOR_CLUSTER,
    mint1: coinIsMintA ? coinToken : assetToken,
    mint2: coinIsMintA ? assetToken : coinToken,
    ammConfig: AMM_CONFIG,
    initialPrice: startPrice,
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

  return {
    poolId,
    positionNftMint: openExtInfo.nftMint.toBase58(),
    tickLower,
    tickUpper,
    startPrice: startPrice.toString(),
    createTx: createResult?.txId ?? String(createResult),
    openTx: openResult?.txId ?? String(openResult),
  };
}
