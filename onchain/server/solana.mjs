import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
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
  TxVersion,
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  PersonalPositionLayout,
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
export const CLMM_LOCK_PROGRAM_ID_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CLMM_LOCK_PROGRAM_ID : DEVNET_PROGRAM_ID.CLMM_LOCK_PROGRAM_ID;
export const CLMM_LOCK_AUTH_ID_FOR_CLUSTER = CLUSTER === 'mainnet-beta' ? CLMM_LOCK_AUTH_ID : DEVNET_PROGRAM_ID.CLMM_LOCK_AUTH_ID;

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
