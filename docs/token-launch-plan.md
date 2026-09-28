# Token Launch Engine — Phase 1 Plan

Scope: turn the "Launch coin" flow in `index.html` from a localStorage mock into a
real on-chain flow. Phase 1 goal is narrow on purpose:

> Create the token and create 1–3 calibrated liquidity pools (one per chosen
> backing asset). Fee collection and reward distribution are **not** built yet.

## In scope

- Real SPL token mint, created from the data the launch form already collects
  (name, ticker, image, 1–3 backing assets).
- Uploading the image + metadata somewhere permanent, not a browser data URL.
- Creating 1, 2, or 3 Raydium pools depending on how many backing assets the
  creator picked — the app UI already caps this at 3
  (`launch-asset-grid` in `index.html`), so the backend only ever needs to
  handle N ∈ {1, 2, 3}.
- Calibrating each pool's starting price so all N pools imply the same
  starting market cap for the coin, regardless of which asset backs which pool.
- **Creator pays the real cost of their launch, platform executes it.**
  Superseded three earlier iterations — see "Fee payer" section below for the
  full reasoning. A launch cannot start unless a wallet is connected, and the
  fee payment itself is what proves that wallet's owner authorized the launch.

## Explicitly deferred (not this phase)

- Collecting `creator_fee_rate` from the pools (Raydium `CollectCreatorFee`).
- Splitting collected fees into Community / Creator / Buyback & Burn.
- Anti-snipe protections on the first block/slot.
- Extending a pool's tick range once it's fully depleted ("graduation" UX).
- Any custom on-chain program. Everything here is existing programs
  (SPL Token / Token-2022, Metaplex Token Metadata, Raydium CLMM) driven from
  an off-chain backend + operator keypair.

## Architecture

```
Frontend (index.html)
   │  1. POST /api/launch/fee-tx { creatorWallet, assetSymbols }
   │       → { txBase64, feeLamports }  (feeLamports = real cost of mint + N pools, see below)
   │  2. connected wallet signs the unsigned transfer tx (solana:signTransaction)
   │  3. POST /api/launch { ...form fields, creatorWallet, signedFeeTxBase64 }
   ▼
Backend service (`onchain/server/`)
   ├─ broadcasts signedFeeTxBase64, confirms it landed — confirmation itself
   │  is the proof the creator's wallet authorized this launch (server/solana.mjs)
   ├─ uploads image + metadata (local placeholder storage for now)
   ├─ mints the coin, creates 1–3 calibrated CLMM pools + single-sided
   │  positions — platform wallet signs and pays for all of it
   └─ persists the launch record (see Data model) → returns mint/pool
      addresses to the frontend
   ▼
Database (`node:sqlite`, `onchain/server/perpside.db`)
```

The frontend keeps doing what it always did (collect the form, show the
preview) — the launch button now asks for one signature (a real SOL transfer
covering the launch's cost) instead of a free message, then makes one request
that does everything else, and calls `PerpsideTokens.add(...)` once that
request returns successfully.

## Fee payer: the creator pays the real cost, the platform executes

Went through four iterations here, worth recording all of them since the
reasoning carries forward:

1. **Platform pays** (original). Simple, but the platform absorbs every
   launch's rent/fees indefinitely — doesn't scale as a cost model.
2. **Creator pays** (tried next). Backend builds every transaction with
   `Raydium.load({ owner: creatorPubkey })` (a bare `PublicKey`, no signing
   capability) and returns them unsigned for the connected wallet to sign via
   `solana:signTransaction`, staged as `prepare-mint → confirm →
   prepare-pool × N` (has to be staged, not one batch — `openPositionFromBase`
   needs the creator's COIN token account to already exist on-chain, which it
   doesn't until the mint tx lands). Fully working and verified, but 1 + 2×N
   separate wallet-approval popups for a 3-asset launch is a rough flow to
   ask a new creator to click through.
3. **Platform-sponsored + free message-signing verification.** Fixed the
   piece iteration 1 was missing: **proof the creator controls the wallet
   they claim.** Previously `creatorWallet` was just a string in the request
   body — anyone could type in any address. Added `POST /api/auth/challenge
   { wallet }` (single-use nonce + message, `server/auth.mjs`, in-memory
   `Map` with a 5-minute TTL) and had the connected wallet sign that message
   via `solana:signMessage` (free, no balance needed) before `/api/launch`
   would proceed — `launch.mjs` verified the Ed25519 signature (`tweetnacl`)
   and deleted the nonce on any verification attempt, so a captured
   signature couldn't be replayed. Worked, verified end-to-end (mocked
   Wallet Standard wallet in Puppeteer, plus bad/replayed-nonce cases
   against the API directly) — but left an unresolved tension: real launches
   cost the platform real SOL (mint + N pools), and a free launch flow has
   no cost-based limit on how many a single wallet — or a script — can
   trigger. Sized correctly this cost also functions as anti-spam, the way
   it naturally does on other launch platforms; sponsoring it away removes
   that function entirely.
4. **Creator pays the real cost, platform still executes everything
   (current).** Resolves the tension iteration 3 left open without going
   back to the 1+2×N-approval flow of iteration 2:
   - `POST /api/launch/fee-tx { creatorWallet, assetSymbols }` computes
     `feeLamports = ceil((mint_cost + N × pool_cost) × 1.15)` — a single
     `SystemProgram.transfer` from creator to platform, `feePayer =
     creator`, built and returned unsigned as base64
     (`calculateLaunchFeeLamports`, `buildFeeTx` in `server/solana.mjs`).
     `mint_cost` (2,575,000 lamports) and `pool_cost` (168,572,000 lamports
     per pool) are the empirically measured real devnet costs (see
     "sizing" note below); the 15% margin keeps the platform from operating
     at a loss on rent-price drift, and in practice nets the platform a
     small surplus per launch (measured: +0.0257 SOL on a real 1-pool
     launch, receiving a 0.1968 SOL fee against a real ~0.171 SOL spend).
   - Frontend signs that transfer via `solana:signTransaction` (a real
     transaction now, not a free message) and sends it back as
     `signedFeeTxBase64` alongside the rest of the launch form in one
     `POST /api/launch`.
   - `launch.mjs` broadcasts and confirms the fee tx *before* doing anything
     else (`broadcastFeeTx`); a failed or missing fee payment is rejected as
     a `LaunchValidationError` and nothing is minted. A confirmed transfer
     requiring `fromPubkey` as signer is itself the proof the creator's
     wallet authorized the launch — Solana rejects a transfer instruction
     missing the source account's signature, so there's nothing further to
     verify. `server/auth.mjs` (the nonce/challenge machinery from iteration
     3) was deleted; it's no longer needed.
   - Once the fee lands, the platform wallet mints the coin and creates all
     1–3 pools exactly as in every prior iteration — the creator never signs
     a mint or pool-creation transaction, only the one fee transfer.

Net effect: one signature prompt, same as iteration 3's UX, but it's a real
payment sized to the actual on-chain cost — the creator can't spam launches
for free, and the platform can't be drained by someone else's script either,
since the fee always covers what the platform is about to spend.

Verified end-to-end against the live API with a real signed transaction
(`test-creator-wallet.json`, real Ed25519 signing via `web3.js`, not
mocked): fee-tx request → sign → `/api/launch` → mint + pool landed on
devnet, DB record correct, platform balance rose by the margin, creator
balance dropped by exactly `feeLamports` + its own tx fee. Also verified the
negative paths directly against the API: `/api/launch` without
`signedFeeTxBase64` is rejected (400, no mint/pool created), `/api/launch/fee-tx`
without a `creatorWallet` is rejected (400), and a garbaged
`signedFeeTxBase64` fails at broadcast (400, simulation failure) before
anything is minted.

One rounding note that applies regardless of who pays: single-sided
positions can require a few atomic units of the backing asset on the
"other side" from fixed-point sqrt-price rounding (`otherAmountMax` in
`createPoolAndPosition`) — the *platform's* wallet needs a small pre-funded
buffer of each backing asset to cover it, since the platform is still the
one executing `openPositionFromBase`
(`server/setup-backing-assets.mjs` pre-funds this once, not per launch).

## Where logo + metadata live

Standard Solana approach, no custom infra to run ourselves:

1. Creator's uploaded image (currently a `data:` URL in the browser) gets
   uploaded server-side to **Arweave** via Irys (formerly Bundlr) at launch
   time. Irys is the common path other Solana launch tools use — pay a small
   amount once, permanent storage, get back a stable `https://arweave.net/<id>`
   URL.
2. Build the standard Metaplex token-metadata JSON
   (`{ name, symbol, description, image, ... }`), upload that JSON the same
   way, get a second URI.
3. Mint the token with Metaplex Token Metadata pointing `uri` at that JSON.
   Wallets/explorers/Jupiter/Raydium all resolve the logo through this, same
   as any other Solana token — nothing custom to maintain.
4. Our own DB still stores the resolved URLs directly (see below) so the
   Explore grid doesn't have to re-resolve on-chain metadata on every page
   load.

## Data model (new backend DB — replaces `PerpsideTokens` localStorage)

Minimum viable schema for this phase:

```
tokens
  mint_address        text primary key
  name                 text
  ticker               text
  image_url            text   -- Arweave URL, not data: URL
  metadata_uri         text   -- Arweave URL to the JSON
  creator_wallet       text
  first_buy_lamports   bigint null
  created_at           timestamptz

token_pools
  id                   uuid primary key
  mint_address         text references tokens
  backing_asset        text   -- 'XSOL' | 'XBTC' | 'XHYPE' | custom symbol
  backing_asset_mint   text   -- mint address of the backing asset
  pool_address         text   -- Raydium CLMM pool id
  position_nft_mint    text   -- our single-sided position
  tick_lower           bigint
  tick_upper           bigint
  initial_sqrt_price   numeric
  created_at           timestamptz
```

`token_pools` has 1–3 rows per token depending on how many assets the creator
picked — nothing enforces exactly 3, the row count *is* N.

## Calibration (same starting market cap across 1–3 pools)

For each chosen backing asset:

1. Get its current USD price from Jupiter's Price API (already used
   client-side for the asset search — same API, now called server-side).
2. Decide a target starting valuation for the coin (e.g. fixed at launch, or
   derived from `firstBuy` if provided — TBD, doesn't block building the
   plumbing).
3. Convert that USD valuation into "COIN per unit of backing asset" and derive
   the pool's initial `sqrt_price` / starting tick from it.
4. Size the single-sided COIN position (which tick range, how much supply)
   the same way per pool, so each pool's implied FDV matches at t=0.

This is the one piece that needs a small devnet script to sanity-check before
wiring it into the real launch flow — the math is understood, the SDK
behavior under our specific parameters isn't verified yet.

### Splitting supply across N pools

Not a single shared formula — two separate steps per launch:

1. **Integer split of total supply across N.** `floor(total / N)` per pool,
   remainder (0 to N-1 atomic units) added to the last pool. Exactly even
   requires picking a total supply divisible by N; otherwise it's even to
   within a few atomic units, which is economically meaningless at normal
   supply sizes. (N here is however many assets the creator picked, 1–3.)
2. **Per-pool inverse liquidity calc.** Each pool has its own tick range
   (from calibration above), so the same token amount maps to a *different*
   liquidity value `L` in each one. For each pool: take its target token
   amount from step 1, solve for the `L` that deposits exactly that amount
   given that pool's specific tick range (Raydium SDK equivalent of
   `getLiquidityFromTokenAmounts`) — don't reuse one `L` across pools.

Expect a few atomic units of leftover dust per pool from fixed-point
(sqrt-price) rounding on top of this. Decided: not worth its own handling
path — just fold it into whichever pool is created first for that launch.

## Rollout steps

1. ~~**Devnet spike**~~ — done. `onchain/` has working scripts
   (`calibrate.mjs`, `launch-spike.mjs`, `verify2.mjs`) that mint a token,
   create a real CLMM pool on devnet, open a single-sided position at a
   calibrated starting price, and independently verify via vault balances
   that it's 100% COIN / 0% backing asset. Confirmed on-chain, not just
   computed. One SDK gotcha found along the way:
   `raydium.clmm.getPoolInfoFromRpc()` throws on a freshly created pool with
   no tick arrays yet (`Object.values` on undefined) — work around by reusing
   the `mockPoolInfo`/`address` that `createPool()` already returns instead
   of re-fetching.
2. ~~**Backend service skeleton**~~ — done. `onchain/server/` is a small
   Express service (`index.mjs`) backed by `node:sqlite`, matching the
   `tokens`/`token_pools` schema above:
   - `POST /api/launch` — mints the coin, uploads image+metadata (local
     placeholder storage for now, see `upload.mjs`), creates 1–3 calibrated
     CLMM pools + single-sided positions, persists everything.
   - `GET /api/tokens`, `GET /api/tokens/:mint`, `GET /api/backing-assets`.
   - `server/setup-backing-assets.mjs` mints the persistent devnet
     xSOL/xBTC/xHYPE stand-ins once (real deployment points at the actual
     Hylo mints instead).

   Tested end-to-end over HTTP for N=1, 2, and 3, with both mintA/mintB
   orderings of COIN vs. the backing asset (pubkey sort decides which one a
   pool assigns as mintA — not something we control per launch). Two bugs
   found and fixed along the way:
   - `poolKeys.id` comes back as a plain string, not a `PublicKey` — calling
     `.toBase58()` on it unconditionally crashed.
   - `otherAmountMax: 0` on `openPositionFromBase` is too strict — fixed-point
     rounding can require a few atomic units on the non-base side depending
     on price magnitude, and the platform wallet had zero balance of the
     backing assets to cover it (Raydium custom error 6017, then SPL
     `InsufficientFunds` once the tolerance was loosened). Fixed by minting a
     small buffer of each backing asset to the platform wallet and allowing
     up to 1000 atomic units of slack instead of exactly 0.
3. ~~**Wire the existing frontend form to it**~~ — done, then went through
   three more reworks as the fee-payer question got settled (see "Fee payer"
   section above — worth reading, the reasoning matters more than the current
   snapshot). Current state: the submit handler in `index.html` first calls
   `payLaunchFee()`, which asks `/api/launch/fee-tx` for the real-cost
   transfer, has the connected wallet sign it (`solana:signTransaction`, a
   real payment now, not a free message), then makes one `POST /api/launch`
   carrying the form fields plus `signedFeeTxBase64`. Launch is hard-blocked
   with an error (and the wallet modal opens) if no wallet is connected, and
   blocked server-side too if the fee payment doesn't land. Errors surface in
   the existing `launchError` element without leaving the form; success folds
   the real `mint`/`pools` addresses into the same `PerpsideTokens.add(...)`
   record, so the preview and Explore grid rendering are untouched. Custom
   assets added via the token-search modal (e.g. JUP) are blocked client-side
   before hitting the network, since the backend only knows xSOL/xBTC/xHYPE
   so far.

   Verified directly against the live API with a real signed transaction
   (`test-creator-wallet.json`, real Ed25519 signing via `web3.js`): fee-tx →
   sign → launch → mint + pool landed on devnet, DB record correct, platform
   balance rose by the margin, creator balance dropped by exactly the quoted
   fee plus its own tx fee. Negative paths (missing fee tx, missing wallet,
   garbaged signature) all rejected with 400s and no mint/pool created.
   Full-browser Puppeteer coverage (mocked Wallet Standard wallet signing a
   real transaction via `solana:signTransaction`) is still worth doing as a
   follow-up but wasn't re-run for this iteration — the API-level coverage
   above already exercises every code path the browser flow calls into.
4. **Mainnet, still no fee distribution** — creator_fee_rate gets configured
   on the pools (so it's collecting from day one) but nothing harvests it yet.
5. Fee collection + Community/Creator/Buyback&Burn distribution — separate,
   later phase.

## Production-readiness pass (2026-09-29)

Went through the "what's left before mainnet" list and did everything that
was pure code/config — no new paid accounts or unverifiable financial
addresses involved:

- **CORS** — `FRONTEND_ORIGIN` env var (comma-separated) now restricts which
  origin can call the API; left unset it stays wide open with a startup
  warning, which was the entire previous behavior (fine for local dev,
  never for a real deploy).
- **Cluster is now a switch, not a hardcode.** `CLUSTER` (`devnet` default,
  or `mainnet-beta`) and `RPC_URL` (`DEVNET_RPC_URL` still works as a
  fallback name) in `solana.mjs` drive the RPC connection, the Raydium
  cluster param, which `CLMM_PROGRAM_ID` gets used, and which `AMM_CONFIG`
  gets used. Going to mainnet is now a config change, not a code change —
  except for backing assets, see below.
- **Mainnet AMM config** — fetched directly from Raydium's own
  `api-v3.raydium.io/main/clmm-config` (the 0.25%-fee/tick-60 entry, same
  fee tier the devnet config already used): id
  `E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp`, index 1. Low-risk lookup
  (a public fee-tier config, not a destination for funds), wired in directly.
- **Backing-asset mainnet addresses — gathered, then confirmed.**
  Cross-referenced Jupiter's token API (filtering for `website: hylo.so`,
  `twitter: hylo_so`) against docs.hylo.so's xAssets page, wrote the
  candidates to `server/backing-assets.mainnet.json`, and had the project
  owner independently confirm all three addresses back before flipping
  `_verified` to `true`. `launch.mjs` refuses to boot on
  `CLUSTER=mainnet-beta` while that flag is `false` — confirmed the refusal
  actually fires, then confirmed it loads correctly once verified. Also
  fixed a real bug found while testing this: `listBackingAssets()` was
  returning the file's `_verified`/`_note`/`_open_question` keys alongside
  the real asset entries, which would've both leaked those notes through
  `GET /api/backing-assets` and broken `assertAssets` if any of those keys
  were ever looked up as a symbol — `loadBackingAssets()` now strips every
  leading-underscore key before treating the rest as the registry. Addresses:
  - xSOL → `4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs`
  - xBTC → `2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL`
  - xHYPE → `7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx` (Jupiter also lists
    a separate "Hylo 3x Leveraged HYPE" mint with no website/socials set —
    treated as an unverified/copycat listing, not used).
- **Real permanent storage.** `upload.mjs` now uploads images + metadata to
  Arweave via Irys (`@irys/upload` + `@irys/upload-solana`) instead of local
  files under `server/uploads/` — same platform wallet funds the Irys
  balance automatically (`ensureFunded`, tops up if short). Verified for
  real on devnet: uploaded an image + a metadata JSON, fetched both back
  over HTTP, correct bytes and content-type. `index.mjs` no longer serves a
  local `/uploads` static route.
- **Live pricing on mainnet.** Pool calibration used to always read a
  hardcoded `usdPrice` from the backing-assets file — fine for devnet
  stand-ins with no real market, actively dangerous on mainnet where a
  stale price would mis-calibrate the pool and hand arbitrageurs the
  difference. `resolveAssetUsdPrice` in `launch.mjs` now fetches a live
  price from Jupiter (same API the frontend already uses) whenever
  `CLUSTER=mainnet-beta`, and refuses to launch rather than fall back to a
  guess if that fails. Devnet path unchanged (still the static price).
- **Partial-failure visibility.** `tokens.status` (`minting` →
  `pools_pending` → `complete`, or `failed` + `error_message`) is now
  written at every stage of `launchToken`, migrated in on server start for
  existing DBs (backfilled to `complete`). Before this, a failure after the
  fee landed but before all pools were created was just a thrown error —
  the creator had paid, the mint existed, and nothing recorded that it was
  stuck. Now it's a queryable row. Verified the migration runs cleanly
  against the existing DB and that both the success and failure status
  sequences write correctly.
- **Secret loading.** `getPlatformWallet()` now prefers a
  `PLATFORM_WALLET_SECRET` env var (JSON-array string — what a secrets
  manager would inject) over reading `devnet-wallet.json` off disk, so a
  real deploy doesn't need that file present at all. This is *not* full
  KMS/HSM custody — the Raydium SDK needs a local signer to call
  `.execute()`, so the key still has to exist in the process's memory at
  some point either way. Real custody hardening (HSM-backed signing, a
  remote signer the process calls out to) would need SDK-level support this
  doesn't have yet.
- **Dependency cleanup** — removed `tweetnacl` and `multer`, both dead since
  `server/auth.mjs` was deleted and local file uploads were replaced.
- Added `.env.example` documenting every env var the backend now reads
  (`RPC_URL`, `CLUSTER`, `FRONTEND_ORIGIN`, `PLATFORM_WALLET_SECRET`, `PORT`)
  — there wasn't one before.

**Still genuinely blocked, not something to fake:**
- TLS/domain/hosting — nothing chosen yet (confirmed with the user); the
  code is config-ready (`FRONTEND_ORIGIN`, `RPC_URL`) but there's no real
  deploy target to point it at.
- A paid mainnet RPC plan — same story, config-ready, no account yet.
- `node:sqlite` → a real multi-instance-safe DB (Postgres) — not attempted
  this pass; would need a provisioned instance to build and test against
  rather than shipping an unvalidated migration.
- Full KMS/HSM custody for the platform wallet — see the secret-loading note
  above; `PLATFORM_WALLET_SECRET` is the honest middle ground available
  without SDK changes.
- Legal/compliance review — outside what any of this can resolve.

## Open questions carried forward (not blockers for starting)

- Exact rule for sizing the single-sided position (fixed supply split evenly
  across N pools? weighted?) — currently: split evenly, revisit later.
- What happens when a pool's range is fully depleted (extend vs. leave it) —
  deferred along with fee distribution.
- (Resolved) A brand-new creator wallet never holding any xSOL/xBTC/xHYPE was
  a real open problem while the creator was the one funding positions — now
  moot, since the platform's own pre-funded buffer
  (`server/setup-backing-assets.mjs`) covers the dust regardless of who the
  creator is. Would resurface if creator-funded pool creation ever comes back
  as an option.
- `MEASURED_MINT_LAMPORTS` / `MEASURED_PER_POOL_LAMPORTS` in `solana.mjs` are
  hardcoded from one measurement session on devnet — real rent/fee costs
  drift over time and would differ on mainnet. Worth re-measuring
  periodically rather than treating them as permanent constants; the 15%
  margin absorbs small drift but not a structural repricing.
- No per-wallet rate limiting beyond the fee cost itself — a creator willing
  to pay full price can still launch as many tokens as they want back to
  back. Acceptable for now since the fee removes the *free* spam vector,
  which was the actual problem; a cooldown could be layered on later if
  needed.
