import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { launchToken, prepareFee, listBackingAssets, LaunchValidationError } from './launch.mjs';
import { listTokens, getToken } from './db.mjs';

const app = express();

// FRONTEND_ORIGIN restricts which site can call this API (comma-separated
// for more than one, e.g. a prod domain + a staging one). Left unset, this
// falls back to allowing any origin — fine for local dev against
// index.html served off a random localhost port, not something to deploy
// with in production.
const allowedOrigins = process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim()) : null;
if (!allowedOrigins) {
  console.warn('FRONTEND_ORIGIN not set — CORS is open to any origin. Set it before deploying.');
}
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));
app.use(express.json({ limit: '15mb' })); // room for base64 image data URLs

app.get('/api/backing-assets', (req, res) => {
  res.json(listBackingAssets());
});

app.get('/api/tokens', (req, res) => {
  res.json(listTokens());
});

app.get('/api/tokens/:mint', (req, res) => {
  const token = getToken(req.params.mint);
  if (!token) return res.status(404).json({ error: 'not found' });
  res.json(token);
});

// Step 1: build the launch fee transfer, sized to how many backing assets
// were picked. Nothing is charged or persisted yet — the creator's wallet
// still has to sign and the fee still has to land before /api/launch does
// anything.
app.post('/api/launch/fee-tx', async (req, res) => {
  try {
    const { creatorWallet, assetSymbols } = req.body;
    const result = await prepareFee({ creatorWallet, assetSymbols });
    res.json(result);
  } catch (err) {
    if (err instanceof LaunchValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'fee-tx failed', detail: err.message });
  }
});

// Step 2: broadcasts the signed fee payment, then — only once that's
// confirmed — mints the coin and creates 1-3 calibrated pools, platform-
// sponsored. See launch.mjs.
app.post('/api/launch', async (req, res) => {
  try {
    const { name, ticker, imageDataUrl, assetSymbols, creatorWallet, signedFeeTxBase64 } = req.body;
    const result = await launchToken({ name, ticker, imageDataUrl, assetSymbols, creatorWallet, signedFeeTxBase64 });
    res.json(result);
  } catch (err) {
    if (err instanceof LaunchValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'launch failed', detail: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`perpside launch service listening on :${port}`);
});
