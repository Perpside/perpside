import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import {
  Raydium,
  DEVNET_PROGRAM_ID,
  CLMM_PROGRAM_ID,
  TxVersion,
  getPdaExBitmapAccount,
  TickArrayBitmapExtensionLayout,
  swapInternal,
} from '@raydium-io/raydium-sdk-v2';
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

// Some RPC-client error messages embed the request URL, which carries our
// API key in its query string — strip it before any such message can reach
// a LaunchValidationError, which is shown verbatim to the client to help
// them debug a failed transaction (see launch.mjs launchToken()).
export function redactSecrets(message) {
  return typeof message === 'string' ? message.split(RPC_URL).join('[rpc]') : message;
}

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
// until it's distributed into pools by createPoolAndPosition.
export async function mintCoinToken() {
  const connection = getConnection();
  const payer = getPlatformWallet();
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey);
  const totalAtomic = TOTAL_SUPPLY_WHOLE * 10n ** BigInt(COIN_DECIMALS);

  // The individual @solana/spl-token helpers (createMint,
  // getOrCreateAssociatedTokenAccount, mintTo) each send their own
  // transaction — fine on their own, but three round trips for four small
  // instructions that fit in one transaction's size limit with room to
  // spare. Composed by hand instead: one transaction, one confirmation.
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
    createMintToInstruction(mint, ata, payer.publicKey, totalAtomic, [], TOKEN_PROGRAM_ID)
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair]);

  return { mint: mint.toBase58(), ata: ata.toBase58() };
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
  return Buffer.from(transaction.serialize()).toString('base64');
}
