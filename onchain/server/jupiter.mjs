// Thin client for Jupiter's public swap API — used only for First Buy's
// SOL -> backing-asset hop (our own pools pair COIN against xSOL/xBTC/xHYPE,
// never native SOL, so getting from SOL to a backing asset needs an
// aggregator). Jupiter only indexes mainnet liquidity — this cannot work on
// devnet, see CLUSTER checks in launch.mjs.
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function getSwapQuote({ inputMint, outputMint, amountLamports, slippageBps = 100 }) {
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Jupiter quote failed: ' + (await res.text()));
  return res.json();
}

// Returns a ready-to-sign, base64 VersionedTransaction with feePayer already
// set to userPublicKey — Jupiter builds the whole transaction itself, we
// just pass it through to the creator's wallet for signing.
export async function buildSwapTx({ quoteResponse, userPublicKey }) {
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true }),
  });
  if (!res.ok) throw new Error('Jupiter swap build failed: ' + (await res.text()));
  const data = await res.json();
  return data.swapTransaction;
}
