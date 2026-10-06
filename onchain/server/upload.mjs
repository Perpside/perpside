// Uploads images + metadata to Arweave via Irys — real permanent storage,
// not a local file that dies on redeploy. Resolvable by any wallet/explorer/
// Jupiter/Raydium the same way as any other Solana token's metadata.
// See docs/token-launch-plan.md "Where logo + metadata live".
import { Uploader } from '@irys/upload';
import { Solana } from '@irys/upload-solana';
import { getPlatformWallet, CLUSTER, RPC_URL } from './solana.mjs';

const GATEWAY = CLUSTER === 'mainnet-beta' ? 'https://gateway.irys.xyz' : 'https://devnet.irys.xyz';

// Deliberately NOT cached across calls (an earlier version built this once
// and reused it for the server's entire lifetime). The Irys SDK itself
// caches ITS OWN `Connection` per uploader instance (see
// @irys/upload-solana's real source, token.js `getProvider` —
// `this.providerInstance ??= new Connection(...)`), pointed at the same
// RPC_URL Perpside's own code uses — but a load-balanced provider (Helius)
// can still route that connection's very first request to a different
// backend node than whichever one Perpside's own `getConnection()` talks
// to, and once pinned (HTTP keep-alive), it stays pinned for as long as
// the object lives. Caught for real in production as a *persistent*
// "Simulation failed... no record of a prior credit" on every launch
// attempt through the one long-lived server process, while a fresh `node`
// process hitting the exact same account over the exact same RPC_URL
// worked immediately — the smoking gun that this was the server's one
// cached connection being stuck on a lagging node, not a one-off race.
// Rebuilding per call means a bad routing decision can't outlive a single
// upload.
async function getIrys() {
  const payer = getPlatformWallet();
  const builder = Uploader(Solana).withWallet(payer.secretKey).withRpc(RPC_URL);
  return (CLUSTER === 'mainnet-beta' ? builder.mainnet() : builder.devnet()).build();
}

// Irys nodes require a funded balance covering the upload's byte price —
// top up the platform wallet's Irys balance if it's short, with a small
// buffer so back-to-back launches don't each pay a separate fund tx.
// Retried on the same transient-node-lag error class getIrys's own comment
// explains: each retry calls getIrys() again (a fresh uploader/connection,
// not the same stuck one), rather than reusing whatever connection just
// failed.
async function ensureFunded(byteLength) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const irys = await getIrys();
    const price = await irys.getPrice(byteLength);
    const balance = await irys.getBalance();
    if (!balance.isLessThan(price)) return irys;
    try {
      await irys.fund(price.minus(balance).multipliedBy(1.5).integerValue());
      return irys;
    } catch (err) {
      const message = `${err?.message || ''} ${err?.transactionMessage || ''}`;
      if (!/prior credit|Simulation failed/i.test(message) || attempt === 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

export async function uploadImage(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');

  const irys = await ensureFunded(buffer.length);
  const receipt = await irys.upload(buffer, { tags: [{ name: 'Content-Type', value: match[1] }] });
  return `${GATEWAY}/${receipt.id}`;
}

export async function uploadMetadata(metadata) {
  const data = Buffer.from(JSON.stringify(metadata));

  const irys = await ensureFunded(data.length);
  const receipt = await irys.upload(data, { tags: [{ name: 'Content-Type', value: 'application/json' }] });
  return `${GATEWAY}/${receipt.id}`;
}
