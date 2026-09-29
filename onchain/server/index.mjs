import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  launchToken,
  prepareFee,
  listBackingAssets,
  getLaunchConfig,
  prepareFirstBuyHop1,
  broadcastFirstBuyHop1,
  prepareFirstBuyHop2,
  broadcastFirstBuyHop2,
  LaunchValidationError,
} from './launch.mjs';
import { listTokens, getToken } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

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

app.get('/api/launch-config', (req, res) => {
  res.json(getLaunchConfig());
});

app.get('/api/tokens', (req, res) => {
  res.json(listTokens());
});

app.get('/api/tokens/:mint', (req, res) => {
  const token = getToken(req.params.mint);
  if (!token) return res.status(404).json({ error: 'not found' });
  res.json(token);
});

// Shared response handling for every /api/launch* route: LaunchValidationError
// is deliberately user-facing (400, shown as-is); anything else is an
// unexpected failure — logged in full server-side, but the client only ever
// gets a generic message (see index.mjs's earlier client-exposure audit —
// an unexpected error's .message can carry internal details, e.g. the RPC
// URL with our API key, that have no business reaching the browser).
function apiRoute(handler, failMessage) {
  return async (req, res) => {
    try {
      res.json(await handler(req.body));
    } catch (err) {
      if (err instanceof LaunchValidationError) {
        return res.status(400).json({ error: err.message });
      }
      console.error(err);
      res.status(500).json({ error: failMessage });
    }
  };
}

// Step 1: build the launch fee transfer, sized to how many backing assets
// were picked. Nothing is charged or persisted yet — the creator's wallet
// still has to sign and the fee still has to land before /api/launch does
// anything.
app.post('/api/launch/fee-tx', apiRoute(prepareFee, 'fee-tx failed'));

// Step 2: broadcasts the signed fee payment, then — only once that's
// confirmed — mints the coin and creates 1-3 calibrated pools, platform-
// sponsored. See launch.mjs.
app.post('/api/launch', apiRoute(launchToken, 'launch failed'));

// First Buy (optional): two creator-signed hops so the resulting COIN lands
// in their own wallet — SOL -> backing asset via Jupiter, then backing
// asset -> COIN via the pool /api/launch just created. Mainnet-only (see
// launch.mjs). Each hop is prepare (build unsigned tx) then broadcast
// (send the signed tx), same shape as /api/launch/fee-tx + /api/launch.
app.post('/api/launch/first-buy/hop1-tx', apiRoute(prepareFirstBuyHop1, 'first-buy hop1 failed'));
app.post('/api/launch/first-buy/hop1', apiRoute(broadcastFirstBuyHop1, 'first-buy hop1 broadcast failed'));
app.post('/api/launch/first-buy/hop2-tx', apiRoute(prepareFirstBuyHop2, 'first-buy hop2 failed'));
app.post('/api/launch/first-buy/hop2', apiRoute(broadcastFirstBuyHop2, 'first-buy hop2 broadcast failed'));

// Same service also serves the static landing page/dashboard (index.html,
// assets/) — one Railway service, one domain, no separate CORS story for
// the frontend calling its own origin's /api/* routes. Static assets are
// registered after the API routes so nothing under /api ever falls through
// to the file server.
app.use('/assets', express.static(path.join(repoRoot, 'assets')));
// '/app' is a client-side-only route (see the history.pushState calls in
// index.html) — there's no server-side app/ content, so a direct load or
// refresh of it needs to get the same index.html the '/' route serves.
app.get(['/', '/app'], (req, res) => res.sendFile(path.join(repoRoot, 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`perpside launch service listening on :${port}`);
});
