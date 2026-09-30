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
  prepareFirstBuy,
  broadcastFirstBuy,
  LaunchValidationError,
} from './launch.mjs';
import { listTokens, getToken, getTokenRewardTotals } from './db.mjs';
import { runRewardCycle } from './rewards.mjs';
import { runGraduationCycle } from './graduation.mjs';
import { startPoolWatcher } from './pool-watcher.mjs';

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
  // Only 'sent' (actually landed) reward payouts count — see db.mjs
  // getTokenRewardTotals. Cheap enough to compute on every request; there's
  // no meaningful traffic volume yet to justify caching it.
  res.json({ ...token, rewardTotals: getTokenRewardTotals(req.params.mint) });
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
// confirmed — mints the coin and opens its pre-market position, platform-
// sponsored. See launch.mjs and docs/token-launch-plan.md "Graduation".
app.post('/api/launch', apiRoute(launchToken, 'launch failed'));

// First Buy (optional): one creator-signed swap, straight through the
// pre-market pool /api/launch just opened (COIN/native-SOL, so no Jupiter
// hop needed — see launch.mjs). Breaking change from the old two-hop
// hop1-tx/hop1/hop2-tx/hop2 routes (removed): the frontend needs to move to
// a single prepare-then-broadcast call with one wallet signature instead of
// two before First Buy works again — see docs/token-launch-plan.md
// "Graduation" for why the old two-hop shape no longer applies.
app.post('/api/launch/first-buy/tx', apiRoute(prepareFirstBuy, 'first-buy failed'));
app.post('/api/launch/first-buy', apiRoute(broadcastFirstBuy, 'first-buy broadcast failed'));

// Reward/graduation crons run as separate Railway Cron Schedule services
// (reward-cron.mjs, graduation-cron.mjs) — deliberately, so a stuck cycle
// can't affect the site staying up, and vice versa. But they can't open
// db.mjs's SQLite file directly: Railway volumes attach to exactly one
// service per environment (confirmed against the real API —
// VolumeInstanceUpdateInput's serviceId "attaches" by *reassigning* the
// existing instance, there's no multi-service simultaneous attachment), so
// only this always-on service — the one with perpside-volume actually
// mounted — can touch the real database. The cron services instead make an
// HTTP call over Railway's private network to these routes and let this
// process do the real work, keeping the "isolated process" property the
// separate-services design wants without needing a second copy of the data.
// Not truly "internal" in the sense of being unreachable from the public
// internet — this Express app answers both perpside.fun and
// perpside.railway.internal on the same port/routes — so a shared secret
// gates it instead.
const INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET;
if (!INTERNAL_CRON_SECRET) {
  console.warn('INTERNAL_CRON_SECRET not set — /internal/* routes will reject every request.');
}

function internalRoute(cycleFn, label) {
  return async (req, res) => {
    if (!INTERNAL_CRON_SECRET || req.get('x-internal-secret') !== INTERNAL_CRON_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      await cycleFn();
      res.json({ ok: true });
    } catch (err) {
      console.error(`${label} failed:`, err);
      res.status(500).json({ error: `${label} failed` });
    }
  };
}

app.post('/internal/run-reward-cycle', internalRoute(runRewardCycle, 'reward cycle'));
app.post('/internal/run-graduation-cycle', internalRoute(runGraduationCycle, 'graduation cycle'));

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

// Real-time graduation trigger — see pool-watcher.mjs. Started after
// app.listen rather than before: the HTTP server coming up doesn't depend
// on this, and startPoolWatcher's own DB read/RPC subscriptions have no
// reason to hold up serving traffic if they're slow on a cold start.
startPoolWatcher();
