// Uploads images + metadata to Arweave via Irys — real permanent storage,
// not a local file that dies on redeploy. Resolvable by any wallet/explorer/
// Jupiter/Raydium the same way as any other Solana token's metadata.
// See docs/token-launch-plan.md "Where logo + metadata live".
import { Uploader } from '@irys/upload';
import { Solana } from '@irys/upload-solana';
import { getPlatformWallet, CLUSTER, RPC_URL } from './solana.mjs';

const GATEWAY = CLUSTER === 'mainnet-beta' ? 'https://gateway.irys.xyz' : 'https://devnet.irys.xyz';

let irysSingleton;

async function getIrys() {
  if (!irysSingleton) {
    const payer = getPlatformWallet();
    const builder = Uploader(Solana).withWallet(payer.secretKey).withRpc(RPC_URL);
    irysSingleton = await (CLUSTER === 'mainnet-beta' ? builder.mainnet() : builder.devnet()).build();
  }
  return irysSingleton;
}

// Irys nodes require a funded balance covering the upload's byte price —
// top up the platform wallet's Irys balance if it's short, with a small
// buffer so back-to-back launches don't each pay a separate fund tx.
async function ensureFunded(irys, byteLength) {
  const price = await irys.getPrice(byteLength);
  const balance = await irys.getBalance();
  if (balance.isLessThan(price)) {
    await irys.fund(price.minus(balance).multipliedBy(1.5).integerValue());
  }
}

export async function uploadImage(mintAddress, dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');

  const irys = await getIrys();
  await ensureFunded(irys, buffer.length);
  const receipt = await irys.upload(buffer, { tags: [{ name: 'Content-Type', value: match[1] }] });
  return `${GATEWAY}/${receipt.id}`;
}

export async function uploadMetadata(mintAddress, metadata) {
  const data = Buffer.from(JSON.stringify(metadata));

  const irys = await getIrys();
  await ensureFunded(irys, data.length);
  const receipt = await irys.upload(data, { tags: [{ name: 'Content-Type', value: 'application/json' }] });
  return `${GATEWAY}/${receipt.id}`;
}
