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
    -- 'minting' -> 'premarket' -> 'graduating' -> 'complete', or 'failed'
    -- with error_message set. A launch stuck on anything but 'complete'
    -- means the fee was already collected but the platform hasn't finished
    -- its side — see launch.mjs launchToken() and
    -- docs/token-launch-plan.md "Graduation". 'pools_pending' is a legacy
    -- value from the old fixed-FDV/immediate-3-CLMM-pool model, kept only
    -- so pre-graduation rows already in the DB keep reading correctly.
    status TEXT NOT NULL DEFAULT 'minting',
    error_message TEXT,
    -- JSON array of the backing assets the creator picked at launch, e.g.
    -- '[{"symbol":"XSOL","mint":"Cpk...","decimals":6}]' — 1-3 entries,
    -- each validated and decimals-resolved on-chain by launch.mjs's
    -- assertAssets at launch time (any real mint, not just the Hylo
    -- xSOL/xBTC/xHYPE registry — see docs/token-launch-plan.md). The new
    -- pre-market flow needs this remembered from launch time: unlike the
    -- old model, final pools (and therefore which assets to split
    -- graduation SOL/COIN across) aren't created until graduation, long
    -- after launch.
    backing_assets TEXT,
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
    -- program (the old model's launch flow did this immediately) — needed
    -- later to call harvestLockPosition and collect this position's accrued
    -- trading fees without ever being able to withdraw the underlying
    -- liquidity itself. This table is legacy under the new pre-market/
    -- graduation model — see premarket_pools/final_pools below.
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
  -- — atomic token amounts can exceed JS's safe integer range. pool_id has
  -- no FK constraint (not "REFERENCES token_pools(id)" as it once was) —
  -- it's the id of a final_pools row for any run created under the new
  -- CPMM model, or a legacy token_pools row for an old CLMM one, and SQLite
  -- can't express an FK against either-of-two tables. Enforced at the app
  -- level (db.mjs's own insert/lookup functions), not the schema level.
  CREATE TABLE IF NOT EXISTS reward_run_pools (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES reward_runs(id),
    pool_id TEXT NOT NULL,
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

  -- The single, unlocked, single-sided CLMM position a launch trades
  -- against before graduation (see solana.mjs createPreMarketPool). One row
  -- per token — a fresh launch creates exactly one of these, never several.
  CREATE TABLE IF NOT EXISTS premarket_pools (
    id TEXT PRIMARY KEY,
    mint_address TEXT NOT NULL REFERENCES tokens(mint_address),
    pool_address TEXT NOT NULL,
    position_nft_mint TEXT NOT NULL,
    tick_lower INTEGER NOT NULL,
    tick_upper INTEGER NOT NULL,
    initial_price TEXT NOT NULL,
    -- active -> closing -> closed. 'closing' covers the window between a
    -- depletion cron deciding to graduate and closePreMarketPool actually
    -- confirming, so a crash mid-close doesn't leave a still-'active' row
    -- that a second cron tick would try to close again.
    status TEXT NOT NULL DEFAULT 'active',
    close_tx TEXT,
    sol_received_lamports TEXT,
    coin_received_atomic TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );

  -- A token's real final pools once graduated: standard Raydium CPMM, one
  -- per backing asset the launch was configured with (1-3), always locked —
  -- createCpmmPoolAndLock never returns before the lock lands, so unlike
  -- legacy token_pools' lock_nft_mint this one is never null. decimals is
  -- carried over from tokens.backing_assets (resolved once, on-chain, at
  -- launch time) rather than re-fetched — since any real mint is allowed
  -- now, not just the three well-known Hylo ones, rewards.mjs needs a real
  -- decimals value for every pool and shouldn't re-hit the RPC for it on
  -- every cron tick.
  CREATE TABLE IF NOT EXISTS final_pools (
    id TEXT PRIMARY KEY,
    mint_address TEXT NOT NULL REFERENCES tokens(mint_address),
    backing_asset TEXT NOT NULL,
    backing_asset_mint TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    -- Classic SPL or Token-2022 (see launch.mjs assertAssets /
    -- solana.mjs getMintInfo) — carried over from tokens.backing_assets
    -- the same way decimals is, so rewards.mjs's ATA derivation for
    -- harvests and payouts uses the right program without re-fetching it.
    token_program TEXT NOT NULL,
    pool_address TEXT NOT NULL,
    lp_mint TEXT NOT NULL,
    lock_nft_mint TEXT NOT NULL,
    swap_tx TEXT,
    create_tx TEXT,
    lock_tx TEXT,
    created_at TEXT NOT NULL
  );

  -- One row per graduation attempt for a token — mirrors reward_runs'
  -- purpose: resumable if the process crashes/redeploys mid-graduation,
  -- since graduateToken is several sequential on-chain steps (close, then a
  -- swap + pool-create per backing asset) and a naive retry-from-scratch
  -- would try to re-close an already-closed position.
  CREATE TABLE IF NOT EXISTS graduation_runs (
    id TEXT PRIMARY KEY,
    mint_address TEXT NOT NULL REFERENCES tokens(mint_address),
    premarket_pool_id TEXT NOT NULL REFERENCES premarket_pools(id),
    status TEXT NOT NULL DEFAULT 'closing', -- closing -> seeding -> complete / failed
    close_tx TEXT,
    sol_raised_lamports TEXT,
    coin_recovered_atomic TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  -- Per-backing-asset progress within a graduation run: this asset's SOL/
  -- COIN share, the swap that converted the SOL share, and the resulting
  -- final_pools row — each step persisted as it lands so a resumed run
  -- knows which assets are already done.
  CREATE TABLE IF NOT EXISTS graduation_run_assets (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES graduation_runs(id),
    backing_asset TEXT NOT NULL,
    backing_asset_mint TEXT NOT NULL,
    sol_share_lamports TEXT NOT NULL,
    coin_share_atomic TEXT NOT NULL,
    swap_tx TEXT,
    asset_amount_atomic TEXT,
    pool_id TEXT REFERENCES final_pools(id),
    status TEXT NOT NULL DEFAULT 'pending', -- pending -> swapped -> pool_created / failed
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
if (!tokenColumns.includes('backing_assets')) {
  db.exec('ALTER TABLE tokens ADD COLUMN backing_assets TEXT');
}
const poolColumns = db.prepare("PRAGMA table_info(token_pools)").all().map((c) => c.name);
if (!poolColumns.includes('lock_nft_mint')) {
  db.exec('ALTER TABLE token_pools ADD COLUMN lock_nft_mint TEXT');
}
const rewardPayoutColumns = db.prepare("PRAGMA table_info(reward_payouts)").all().map((c) => c.name);
if (!rewardPayoutColumns.includes('secondary_amount')) {
  // Only meaningful for kind='buyback': `amount` is the backing-asset amount
  // that went *into* the swap (needed to resume a stuck buyback with the
  // exact original amount, see rewards.mjs); this is the COIN amount that
  // came *out* and actually got burned — what the token page's "burned"
  // stat needs.
  db.exec('ALTER TABLE reward_payouts ADD COLUMN secondary_amount TEXT');
}

// reward_run_pools.pool_id originally had "REFERENCES token_pools(id)" —
// wrong under the new CPMM model, whose pool_id values are final_pools
// rows (see the table's own comment above). SQLite can't ALTER a column's
// FK constraint in place, so this recreates the table without it whenever
// an older DB still has the stale constraint — detected by checking the
// table's own stored SQL text rather than assuming, since ALTER TABLE
// ADD COLUMN migrations elsewhere in this file leave old constraints
// untouched. Existing rows are preserved as-is; there's nothing to
// re-validate since dropping a constraint can't make a row invalid.
const rewardRunPoolsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reward_run_pools'").get()?.sql;
if (rewardRunPoolsSql?.includes('token_pools')) {
  db.exec(`
    CREATE TABLE reward_run_pools_new (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES reward_runs(id),
      pool_id TEXT NOT NULL,
      backing_asset TEXT NOT NULL,
      backing_asset_mint TEXT NOT NULL,
      harvested_amount TEXT,
      harvest_tx TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO reward_run_pools_new SELECT * FROM reward_run_pools;
    DROP TABLE reward_run_pools;
    ALTER TABLE reward_run_pools_new RENAME TO reward_run_pools;
  `);
}

const finalPoolColumns = db.prepare("PRAGMA table_info(final_pools)").all().map((c) => c.name);
if (!finalPoolColumns.includes('decimals')) {
  // No NOT NULL/default possible here — SQLite can't backfill a real
  // per-row value on ALTER. Harmless in practice: there were zero real
  // final_pools rows in production when this landed (the graduation
  // feature's first mainnet pools didn't exist yet), and insertFinalPool
  // always provides a real value for every row created from here on.
  db.exec('ALTER TABLE final_pools ADD COLUMN decimals INTEGER');
}
if (!finalPoolColumns.includes('token_program')) {
  db.exec('ALTER TABLE final_pools ADD COLUMN token_program TEXT');
}

export function insertToken({
  mintAddress, name, ticker, imageUrl, metadataUri, creatorWallet, firstBuyLamports, status,
  xLink, telegramLink, websiteLink, communityFee, creatorFee, buybackFee, backingAssets,
}) {
  db.prepare(`
    INSERT INTO tokens (
      mint_address, name, ticker, image_url, metadata_uri, creator_wallet, first_buy_lamports, status,
      x_link, telegram_link, website_link, community_fee, creator_fee, buyback_fee, backing_assets, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mintAddress, name, ticker, imageUrl ?? null, metadataUri ?? null, creatorWallet ?? null, firstBuyLamports ?? null, status ?? 'minting',
    xLink ?? null, telegramLink ?? null, websiteLink ?? null, communityFee ?? null, creatorFee ?? null, buybackFee ?? null,
    backingAssets ? JSON.stringify(backingAssets) : null,
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

// Only 'complete' launches have real pools to check — 'minting'/'premarket'/
// 'graduating'/'failed' launches have nothing (or only partial state) to
// harvest against. A token only ever reaches 'complete' via graduation now
// (see graduation.mjs), so its real pools are in final_pools (CPMM), not
// the legacy token_pools table — see rewards.mjs "Reward cron: CPMM".
export function listCompleteTokens() {
  const tokens = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS} FROM tokens WHERE status = 'complete' ORDER BY created_at ASC`).all();
  return tokens.map((t) => ({
    ...t,
    pools: db.prepare('SELECT * FROM final_pools WHERE mint_address = ?').all(t.mint_address),
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

export function markRewardBuybackSent(id, txId, burnedCoinAmount) {
  db.prepare("UPDATE reward_payouts SET status = 'sent', tx_id = ?, secondary_amount = ? WHERE id = ?")
    .run(txId, String(burnedCoinAmount), id);
}

export function insertPremarketPool({ id, mintAddress, poolAddress, positionNftMint, tickLower, tickUpper, initialPrice }) {
  db.prepare(`
    INSERT INTO premarket_pools (id, mint_address, pool_address, position_nft_mint, tick_lower, tick_upper, initial_price, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, mintAddress, poolAddress, positionNftMint, tickLower, tickUpper, initialPrice, new Date().toISOString());
}

// Only ever one 'active'/'closing' row per token at a time — a token past
// graduation has no reason to look this up again.
export function getActivePremarketPool(mintAddress) {
  return db.prepare(`
    SELECT * FROM premarket_pools WHERE mint_address = ? AND status IN ('active', 'closing') ORDER BY created_at DESC LIMIT 1
  `).get(mintAddress);
}

export function updatePremarketPoolStatus(id, status) {
  db.prepare('UPDATE premarket_pools SET status = ? WHERE id = ?').run(status, id);
}

export function markPremarketPoolClosed(id, closeTx, solReceivedLamports, coinReceivedAtomic) {
  db.prepare(`
    UPDATE premarket_pools SET status = 'closed', close_tx = ?, sol_received_lamports = ?, coin_received_atomic = ?, closed_at = ? WHERE id = ?
  `).run(closeTx, String(solReceivedLamports), String(coinReceivedAtomic), new Date().toISOString(), id);
}

// Every token currently trading pre-graduation — what a depletion-detection
// cron iterates to check each one's pool against its ceiling tick.
// backing_assets is pulled in here (not part of PUBLIC_TOKEN_COLUMNS,
// which the actual public /api/tokens endpoint shares) since graduation
// needs it internally to know which assets to seed final pools with —
// no reason to also change the public API's response shape for that.
export function listPremarketTokens() {
  const tokens = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS}, backing_assets FROM tokens WHERE status = 'premarket' ORDER BY created_at ASC`).all();
  return tokens.map((t) => ({
    ...t,
    backingAssets: t.backing_assets ? JSON.parse(t.backing_assets) : null,
    premarketPool: db.prepare("SELECT * FROM premarket_pools WHERE mint_address = ? AND status = 'active'").get(t.mint_address),
  }));
}

// Same shape as one listPremarketTokens() row, for pool-watcher.mjs's
// account-change callback — a single real-time trade event only ever needs
// to re-check the one token it's about, not the whole premarket list.
export function getPremarketToken(mintAddress) {
  const t = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS}, backing_assets FROM tokens WHERE mint_address = ? AND status = 'premarket'`).get(mintAddress);
  if (!t) return null;
  return {
    ...t,
    backingAssets: t.backing_assets ? JSON.parse(t.backing_assets) : null,
    premarketPool: db.prepare("SELECT * FROM premarket_pools WHERE mint_address = ? AND status = 'active'").get(mintAddress),
  };
}

// Tokens mid-graduation when the process last exited — resumable the same
// way listPremarketTokens' active pools are, just further along (the pool
// row is 'closing', not 'active', by the time a token reaches this status).
export function listGraduatingTokens() {
  const tokens = db.prepare(`SELECT ${PUBLIC_TOKEN_COLUMNS}, backing_assets FROM tokens WHERE status = 'graduating' ORDER BY created_at ASC`).all();
  return tokens.map((t) => ({
    ...t,
    backingAssets: t.backing_assets ? JSON.parse(t.backing_assets) : null,
    premarketPool: db.prepare("SELECT * FROM premarket_pools WHERE mint_address = ? AND status = 'closing'").get(t.mint_address),
  }));
}

export function insertFinalPool({ id, mintAddress, backingAsset, backingAssetMint, decimals, tokenProgram, poolAddress, lpMint, lockNftMint, swapTx, createTx, lockTx }) {
  db.prepare(`
    INSERT INTO final_pools (id, mint_address, backing_asset, backing_asset_mint, decimals, token_program, pool_address, lp_mint, lock_nft_mint, swap_tx, create_tx, lock_tx, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, mintAddress, backingAsset, backingAssetMint, decimals, tokenProgram, poolAddress, lpMint, lockNftMint, swapTx ?? null, createTx ?? null, lockTx ?? null, new Date().toISOString());
}

export function getFinalPools(mintAddress) {
  return db.prepare('SELECT * FROM final_pools WHERE mint_address = ?').all(mintAddress);
}

// Mirrors getIncompleteRewardRun: a run still 'closing'/'seeding'/'failed'
// when the process last exited is resumable rather than restarted from
// scratch, so a retry doesn't try to re-close an already-closed pre-market
// position.
export function getIncompleteGraduationRun(mintAddress) {
  return db.prepare(`
    SELECT * FROM graduation_runs WHERE mint_address = ? AND status IN ('closing', 'seeding', 'failed') ORDER BY created_at DESC LIMIT 1
  `).get(mintAddress);
}

export function createGraduationRun(mintAddress, premarketPoolId) {
  const id = randomUUID();
  db.prepare('INSERT INTO graduation_runs (id, mint_address, premarket_pool_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, mintAddress, premarketPoolId, 'closing', new Date().toISOString());
  return id;
}

export function markGraduationRunClosed(id, closeTx, solRaisedLamports, coinRecoveredAtomic) {
  db.prepare(`
    UPDATE graduation_runs SET status = 'seeding', close_tx = ?, sol_raised_lamports = ?, coin_recovered_atomic = ? WHERE id = ?
  `).run(closeTx, String(solRaisedLamports), String(coinRecoveredAtomic), id);
}

export function updateGraduationRunStatus(id, status, errorMessage) {
  const completedAt = status === 'complete' || status === 'failed' ? new Date().toISOString() : null;
  db.prepare('UPDATE graduation_runs SET status = ?, error_message = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?')
    .run(status, errorMessage ?? null, completedAt, id);
}

export function getGraduationRunAssets(runId) {
  return db.prepare('SELECT * FROM graduation_run_assets WHERE run_id = ?').all(runId);
}

export function insertGraduationRunAsset({ runId, backingAsset, backingAssetMint, solShareLamports, coinShareAtomic }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO graduation_run_assets (id, run_id, backing_asset, backing_asset_mint, sol_share_lamports, coin_share_atomic, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, runId, backingAsset, backingAssetMint, String(solShareLamports), String(coinShareAtomic), new Date().toISOString());
  return id;
}

export function markGraduationRunAssetSwapped(id, swapTx, assetAmountAtomic) {
  db.prepare("UPDATE graduation_run_assets SET status = 'swapped', swap_tx = ?, asset_amount_atomic = ? WHERE id = ?")
    .run(swapTx, String(assetAmountAtomic), id);
}

export function markGraduationRunAssetPoolCreated(id, poolId) {
  db.prepare("UPDATE graduation_run_assets SET status = 'pool_created', pool_id = ? WHERE id = ?").run(poolId, id);
}

export function updateGraduationRunAssetStatus(id, status, errorMessage) {
  db.prepare('UPDATE graduation_run_assets SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage ?? null, id);
}

// Real (successfully sent) totals for a token's page — grouped by kind and,
// for community/creator, by backing asset (each pool pays out in its own
// asset, never a common one, see rewards.mjs). Summed in JS with BigInt
// rather than SQL SUM: atomic token amounts can exceed the ~2^53 range
// SQLite's SUM silently loses precision above.
export function getTokenRewardTotals(mintAddress) {
  const rows = db.prepare(`
    SELECT rp.kind, rp.amount, rp.secondary_amount, rrp.backing_asset
    FROM reward_payouts rp
    JOIN reward_run_pools rrp ON rp.run_pool_id = rrp.id
    JOIN reward_runs rr ON rrp.run_id = rr.id
    WHERE rr.mint_address = ? AND rp.status = 'sent'
  `).all(mintAddress);

  const community = {}; // { XSOL: '123', XBTC: '456', ... }
  const creator = {};
  let burnedCoin = 0n;

  for (const row of rows) {
    if (row.kind === 'community') {
      community[row.backing_asset] = ((BigInt(community[row.backing_asset] || '0')) + BigInt(row.amount)).toString();
    } else if (row.kind === 'creator') {
      creator[row.backing_asset] = ((BigInt(creator[row.backing_asset] || '0')) + BigInt(row.amount)).toString();
    } else if (row.kind === 'buyback' && row.secondary_amount != null) {
      burnedCoin += BigInt(row.secondary_amount);
    }
  }
  return { community, creator, burnedCoin: burnedCoin.toString() };
}
