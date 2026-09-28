// One-time setup: mint persistent devnet stand-in tokens for xSOL/xBTC/xHYPE.
// Real launches would point at the actual Hylo mainnet mints instead — this
// only exists because Hylo isn't deployed to devnet.
import { Connection, Keypair } from '@solana/web3.js';
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const walletPath = path.join(__dirname, '..', 'devnet-wallet.json');
const outPath = path.join(__dirname, 'backing-assets.json');

// devnet-only: this mints brand-new stand-in tokens, which would be
// meaningless (and dangerous to confuse with the real thing) on mainnet,
// where Hylo's actual xSOL/xBTC/xHYPE already exist.
if (process.env.CLUSTER === 'mainnet-beta') {
  throw new Error('setup-backing-assets.mjs is devnet-only — point CLUSTER at devnet, or use the real Hylo mainnet mints directly instead of running this script');
}

const secret = JSON.parse(fs.readFileSync(walletPath));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(process.env.RPC_URL || process.env.DEVNET_RPC_URL, 'confirmed');

// Stand-in USD prices — real deployment would call Jupiter's Price API for
// the live xSOL/xBTC/xHYPE mints instead of a hardcoded number.
const ASSETS = [
  { symbol: 'XSOL', decimals: 6, usdPrice: 150 },
  { symbol: 'XBTC', decimals: 6, usdPrice: 60000 },
  { symbol: 'XHYPE', decimals: 6, usdPrice: 25 },
];

const registry = {};
for (const asset of ASSETS) {
  const mint = await createMint(connection, payer, payer.publicKey, null, asset.decimals);
  await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  registry[asset.symbol] = { mint: mint.toBase58(), decimals: asset.decimals, usdPrice: asset.usdPrice };
  console.log(asset.symbol, '->', mint.toBase58());
}

fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));
console.log('saved to', outPath);
