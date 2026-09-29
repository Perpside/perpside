import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH lets a deploy point this at a mounted volume (e.g. Railway) so the
// launch history survives restarts/redeploys — a plain container filesystem
// is wiped on every deploy. Falls back to a file next to this module for
// local dev.
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'perpside.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    mint_address TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    image_url TEXT,
    metadata_uri TEXT,
    creator_wallet TEXT,
    first_buy_lamports INTEGER,
    x_link TEXT,
    telegram_link TEXT,
    website_link TEXT,
    -- Reward-model config the creator picked at launch (see the launch
    -- form's Community/Creator/Buyback toggles). Stored so Explore can
    -- display what a launch is configured for; collecting and distributing
    -- these fees is still a separate, not-yet-built phase — see
    -- docs/token-launch-plan.md "Explicitly deferred".
    community_fee REAL,
    creator_fee REAL,
    buyback_fee REAL,
    -- 'minting' -> 'pools_pending' -> 'complete', or 'failed' with
    -- error_message set. A launch stuck on anything but 'complete' means the
    -- fee was already collected but the platform hasn't finished its side —
    -- see launch.mjs launchToken() and docs/token-launch-plan.md.
    status TEXT NOT NULL DEFAULT 'minting',
    error_message TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS token_pools (
    id TEXT PRIMARY KEY,
    mint_address TEXT NOT NULL REFERENCES tokens(mint_address),
    backing_asset TEXT NOT NULL,
    backing_asset_mint TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    position_nft_mint TEXT NOT NULL,
    -- Set once the position is locked via Raydium's Lock CL Position
    -- program (see solana.mjs createPoolAndPosition) — needed later to call
    -- harvestLockPosition and collect this position's accrued trading fees
    -- without ever being able to withdraw the underlying liquidity itself.
    lock_nft_mint TEXT,
    tick_lower INTEGER NOT NULL,
    tick_upper INTEGER NOT NULL,
    initial_price TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- One row per triggered reward cycle for a token (see rewards.mjs) — a
  -- token's accrued fees crossed the USD threshold, so its pools get
  -- harvested and split into community/creator/buyback. Exists mainly so a
  -- crash mid-run is resumable without re-harvesting a pool that already
  -- paid out or re-sending a payout that already landed.
  CREATE TABLE IF NOT EXISTS reward_runs (
    id TEXT PRIMARY KEY,
    mint_address TEXT NOT NULL REFERENCES tokens(mint_address),
    status TEXT NOT NULL DEFAULT 'harvesting', -- harvesting -> distributing -> complete / failed
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  -- Per-pool harvest result within a run. amount fields are stored as text
  -- — atomic token amounts can exceed JS's safe integer range.
  CREATE TABLE IF NOT EXISTS reward_run_pools (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES reward_runs(id),
    pool_id TEXT NOT NULL REFERENCES token_pools(id),
    backing_asset TEXT NOT NULL,
    backing_asset_mint TEXT NOT NULL,
    harvested_amount TEXT,
    harvest_tx TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending -> harvested -> distributed / failed
    error_message TEXT,
    created_at TEXT NOT NULL
  );

  -- Individual payouts from a harvested pool: community (per real holder),
  -- creator (single transfer), buyback (swap + burn, recipient_wallet null).
  CREATE TABLE IF NOT EXISTS reward_payouts (
    id TEXT PRIMARY KEY,
    run_pool_id TEXT NOT NULL REFERENCES reward_run_pools(id),
    kind TEXT NOT NULL, -- community | creator | buyback
    recipient_wallet TEXT,
    amount TEXT NOT NULL,
    tx_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending -> sent / skipped_dust / failed
    error_message TEXT,
    created_at TEXT NOT NULL
  );
`);

// node:sqlite has no migration tooling — ALTER TABLE guarded by a pragma
// check so this stays idempotent across restarts for DBs created before
// `status`/`error_message` existed.
const tokenColumns = db.prepare("PRAGMA table_info(tokens)").all().map((c) => c.name);
if (!tokenColumns.includes('status')) {
  db.exec("ALTER TABLE tokens ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'");
}
if (!tokenColumns.includes('error_message')) {
  db.exec('ALTER TABLE tokens ADD COLUMN error_message TEXT');
}
for (const col of ['x_link', 'telegram_link', 'website_link']) {
  if (!tokenColumns.includes(col)) db.exec(`ALTER TABLE tokens ADD COLUMN ${col} TEXT`);
}
for (const col of ['community_fee', 'creator_fee', 'buyback_fee']) {
  if (!tokenColumns.includes(col)) db.exec(`ALTER TABLE tokens ADD COLUMN ${col} REAL`);
}
const poolColumns = db.prepare("PRAGMA table_info(token_pools)").all().map((c) => c.name);
if (!poolColumns.includes('lock_nft_mint')) {
  db.exec('ALTER TABLE token_pools ADD COLUMN lock_nft_mint TEXT');
}

export function insertToken({
  mintAddress, name, ticker, imageUrl, metadataUri, creatorWallet, firstBuyLamports, status,
  xLink, telegramLink, websiteLink, communityFee, creatorFee, buybackFee,
}) {
  db.prepare(`
    INSERT INTO tokens (
      mint_address, name, ticker, image_url, metadata_uri, creator_wallet, first_buy_lamports, status,
      x_link, telegram_link, website_link, community_fee, creator_fee, buyback_fee, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mintAddress, name, ticker, imageUrl ?? null, metadataUri ?? null, creatorWallet ?? null, firstBuyLamports ?? null, status ?? 'minting',
    xLink ?? null, telegramLink ?? null, websiteLink ?? null, communityFee ?? null, creatorFee ?? null, buybackFee ?? null,
    new Date().toISOString()
  );
}

export function updateTokenStatus(mintAddress, status, errorMessage) {
  db.prepare('UPDATE tokens SET status = ?, error_message = ? WHERE mint_address = ?')
    .run(status, errorMessage ?? null, mintAddress);
}

export function updateTokenMedia(mintAddress, imageUrl, metadataUri) {
  db.prepare('UPDATE tokens SET image_url = ?, metadata_uri = ? WHERE mint_address = ?')
    .run(imageUrl ?? null, metadataUri ?? null, mintAddress);
}

export function updateFirstBuy(mintAddress, lamports) {
  db.prepare('UPDATE tokens SET first_buy_lamports = ? WHERE mint_address = ?').run(lamports, mintAddress);
}

export function insertPool({ id, mintAddress, backingAsset, backingAssetMint, poolAddress, positionNftMint, lockNftMint, tickLower, tickUpper, initialPrice }) {
  db.prepare(`
    INSERT INTO token_pools (id, mint_address, backing_asset, backing_asset_mint, pool_address, position_nft_mint, lock_nft_mint, tick_lower, tick_upper, initial_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, mintAddress, backingAsset, backingAssetMint, poolAddress, positionNftMint, lockNftMint ?? null, tickLower, tickUpper, initialPrice, new Date().toISOString());
}

// error_message is deliberately excluded here — it's a raw internal
// exception message (can end up carrying RPC error text, occasionally with
// the RPC URL/API key embedded) meant for server-side debugging only, not
// for the public, unauthenticated /api/tokens response. `status` alone is
// enough for the client to know a launch didn't finish cleanly.
const PUBLIC_TOKEN_COLUMNS = `
  mint_address, name, ticker, image_url, metadata_uri, creator_wallet, first_buy_lamports, status,
  x_link, telegram_link, website_link, community_fee, creator_fee, buyback_fee, created_at
`;

export function getToken(mintAddress) {
  const token = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS} FROM tokens WHERE mint_address = ?`).get(mintAddress);
  if (!token) return null;
  const pools = db.prepare('SELECT * FROM token_pools WHERE mint_address = ?').all(mintAddress);
  return { ...token, pools };
}

export function listTokens() {
  const tokens = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS} FROM tokens ORDER BY created_at DESC`).all();
  return tokens.map((t) => ({
    ...t,
    pools: db.prepare('SELECT * FROM token_pools WHERE mint_address = ?').all(t.mint_address),
  }));
}

// Only 'complete' launches have real pools to check — 'pools_pending' or
// 'failed' launches have nothing (or only partial state) to harvest against.
export function listCompleteTokens() {
  const tokens = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS} FROM tokens WHERE status = 'complete' ORDER BY created_at ASC`).all();
  return tokens.map((t) => ({
    ...t,
    pools: db.prepare('SELECT * FROM token_pools WHERE mint_address = ?').all(t.mint_address),
  }));
}

// A run still in 'harvesting'/'distributing' when the cron process last
// exited (crash, redeploy, timeout) means work is resumable — checked
// before starting a fresh run for the same token so nothing gets
// re-harvested or double-paid. 'failed' is included too: every payout step
// in rewards.mjs is idempotent per kind (checks what's already persisted
// before sending anything new), so retrying a failed run on the next tick
// is safe and is how a transient error (a dropped RPC call, a momentary
// price lookup failure) recovers on its own instead of leaving funds
// stuck mid-distribution.
export function getIncompleteRewardRun(mintAddress) {
  return db.prepare(`
    SELECT * FROM reward_runs WHERE mint_address = ? AND status IN ('harvesting', 'distributing', 'failed') ORDER BY created_at DESC LIMIT 1
  `).get(mintAddress);
}

export function createRewardRun(mintAddress) {
  const id = randomUUID();
  db.prepare('INSERT INTO reward_runs (id, mint_address, status, created_at) VALUES (?, ?, ?, ?)')
    .run(id, mintAddress, 'harvesting', new Date().toISOString());
  return id;
}

export function updateRewardRunStatus(id, status, errorMessage) {
  const completedAt = status === 'complete' || status === 'failed' ? new Date().toISOString() : null;
  db.prepare('UPDATE reward_runs SET status = ?, error_message = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?')
    .run(status, errorMessage ?? null, completedAt, id);
}

export function getRewardRunPools(runId) {
  return db.prepare('SELECT * FROM reward_run_pools WHERE run_id = ?').all(runId);
}

export function insertRewardRunPool({ runId, poolId, backingAsset, backingAssetMint }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO reward_run_pools (id, run_id, pool_id, backing_asset, backing_asset_mint, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, runId, poolId, backingAsset, backingAssetMint, new Date().toISOString());
  return id;
}

export function markRewardRunPoolHarvested(id, harvestedAmount, harvestTx) {
  db.prepare("UPDATE reward_run_pools SET status = 'harvested', harvested_amount = ?, harvest_tx = ? WHERE id = ?")
    .run(String(harvestedAmount), harvestTx, id);
}

export function updateRewardRunPoolStatus(id, status, errorMessage) {
  db.prepare('UPDATE reward_run_pools SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage ?? null, id);
}

export function insertRewardPayout({ runPoolId, kind, recipientWallet, amount, txId, status, errorMessage }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO reward_payouts (id, run_pool_id, kind, recipient_wallet, amount, tx_id, status, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runPoolId, kind, recipientWallet ?? null, String(amount), txId ?? null, status, errorMessage ?? null, new Date().toISOString());
  return id;
}

export function getRewardPayouts(runPoolId) {
  return db.prepare('SELECT * FROM reward_payouts WHERE run_pool_id = ?').all(runPoolId);
}

export function markRewardPayoutSent(id, txId) {
  db.prepare("UPDATE reward_payouts SET status = 'sent', tx_id = ? WHERE id = ?").run(txId, id);
}

export function markRewardPayoutFailed(id, errorMessage) {
  db.prepare("UPDATE reward_payouts SET status = 'failed', error_message = ? WHERE id = ?").run(errorMessage ?? null, id);
}
