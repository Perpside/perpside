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

- ~~Collecting `creator_fee_rate` from the pools (Raydium `CollectCreatorFee`).~~
  ~~Splitting collected fees into Community / Creator / Buyback & Burn.~~ Built —
  see "Reward cron: harvest + Community/Creator/Buyback distribution" below.
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

Standard Solana approach, no custom infra to run ourselves — fully built
now (was aspirational when first written; see "Metaplex metadata + revoked
authorities" further down for when steps 3-4 actually landed):

1. Creator's uploaded image (a `data:` URL in the browser) gets uploaded
   server-side to **Arweave** via Irys at launch time — permanent storage,
   stable URL (`upload.mjs`).
2. Build the standard Metaplex token-metadata JSON
   (`{ name, symbol, description, image }`), upload that JSON the same way,
   get a second URI. Both uploads now happen *before* minting (see below) —
   the mint transaction needs a real URI to point its on-chain metadata at.
3. Mint the token with Metaplex Token Metadata pointing `uri` at that JSON,
   `isMutable: false`. Wallets/explorers/Jupiter/Raydium all resolve the
   logo through this, same as any other Solana token — nothing custom to
   maintain.
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
2. Decide a target starting valuation for the coin — resolved as a fixed
   constant (`DEFAULT_TARGET_FDV_USD` in `launch.mjs`), same for every
   launch. First Buy does *not* feed into this: it's a separate, optional
   swap that happens after the pools already exist, not a launch-time input
   — see "First Buy" further down.
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

## First Buy: real, creator-signed, two hops (2026-09-29)

Previously purely cosmetic — the amount typed into the form only fed the
local `PerpsideTokens.add(...)` preview, never reached the backend, and
`tokens.first_buy_lamports` was always inserted as `null`. Now it's a real
on-chain purchase, same principle as the launch fee: **creator signs, COIN
lands in their own wallet**, not the platform's.

**Why two hops, not one.** Our pools only ever pair COIN against
xSOL/xBTC/xHYPE — never native SOL — so turning a SOL amount into COIN is
unavoidably: (1) SOL → backing asset, (2) backing asset → COIN. Considered
composing both into one versioned transaction (Jupiter's instructions +
our own Raydium swap instruction, one signature) but went with two separate
signed transactions instead:
- Hop 2's input amount is read from the creator's **real post-hop-1
  balance** (`getTokenBalance` in `solana.mjs`) rather than trusting hop 1's
  pre-swap quote — this fully sidesteps any slippage-estimation mismatch
  between the two hops, at the cost of one extra wallet popup. Given First
  Buy is opt-in to begin with, correctness over one fewer click.
- Composing a third-party aggregator's instructions with our own in a single
  versioned tx (shared address-lookup-tables, exact account ordering) is
  real complexity for a UX win on an optional feature — not worth it yet.

**Hop 1 (SOL → backing asset) is mainnet-only.** Jupiter doesn't index or
route devnet tokens at all (confirmed directly — quoting our devnet xSOL
stand-in returns `TOKEN_NOT_TRADABLE`); `prepareFirstBuyHop1` in
`launch.mjs` refuses with a clear `LaunchValidationError` on any other
cluster. Uses Jupiter's public swap API (`lite-api.jup.ag/swap/v1`
`quote` + `swap`) — the same host already used for token search — which
hands back a ready-to-sign transaction with `feePayer` already set to the
creator, no building required on our side.

**Hop 2 (backing asset → COIN) is our own Raydium CLMM swap**, built with
`owner` = the creator's bare `PublicKey` (same unsigned-tx-before-`.execute()`
pattern used everywhere else a creator signs), following Raydium's own
documented single-pool-swap pattern exactly
(`raydium-sdk-V2-demo/src/clmm/swap.ts`: `clmm.getSwapPoolInfo` →
`getPdaExBitmapAccount` + fetch/decode the bitmap extension →
`swapInternal` to simulate `remainingAccounts`/`amountOutMin` → `clmm.swap`).
This method needed lower-level manual account wiring than `createPool`/
`openPositionFromBase` — there's no single convenience call for it.
`amountOutMin` is the simulated output with a 1% haircut, not the exact
simulated value, so small price drift between simulation and confirmation
doesn't fail the swap outright.

**Verified for real on devnet** (hop 2 only — hop 1 categorically can't run
there, see above): pointed it at an existing pool from earlier testing,
had the test creator wallet spend its entire real xSOL balance (~10 xSOL)
through `/api/launch/first-buy/hop2-tx` → sign → `/api/launch/first-buy/hop2`.
Confirmed on-chain: xSOL balance went to zero, COIN landed directly in the
creator's own wallet (not the platform's), and `first_buy_lamports` was
recorded in the DB correctly. Hop 1 is implemented against Jupiter's
documented API contract and that contract was verified live (real quote +
real ready-to-sign transaction for a live mainnet pair), but the actual
sign-and-broadcast path has not been exercised against real mainnet funds.

**New endpoints:** `GET /api/launch-config` (`{targetFdvUsd,
totalSupplyWhole}` — every launch starts at the same price, so the frontend
uses this + a live SOL/USD price from Jupiter to show a live "≈ N COIN"
estimate as the creator types an amount, clearly labeled as an estimate
before fees/slippage) and the four-route `/api/launch/first-buy/{hop1,hop2}{-tx,}`
pair. Also fixed a real, adjacent bug while building this: the Wallet
Standard `chain` parameter for `solana:signTransaction` was hardcoded to
`'solana:devnet'` everywhere, including the original launch-fee signing
call — silently wrong the moment `CLUSTER` flips to `mainnet-beta`.
`prepareFee`/both first-buy prepare functions now return `cluster: CLUSTER`
alongside the unsigned tx, and the frontend picks the matching chain string
off that instead of a hardcoded guess.

A failed First Buy never undoes the launch itself, which has already
succeeded by the time First Buy runs — it surfaces as a distinct
non-blocking message ("Coin launched, but First Buy failed: ... — you can
still buy it from Explore") rather than the main launch-failure error.

## Mint step: 3 transactions → 1 (2026-09-29)

Prompted by a question about whether Solana's recent compute/size-limit
changes could shrink a launch's transaction count. Short answer on that:
the per-transaction CU cap is still 1.4M (unchanged — what actually grew is
the *block-level* limit, 60M→100M CU, a throughput change, not a
per-tx one), and the transaction *byte-size* cap did grow (1232→4096 bytes,
mainnet epoch 1035, 2026-09-15) but only for a new `v1` transaction format
that neither the Raydium SDK (`0.2.73-alpha`) nor, likely, wallets support
building/signing yet — not usable today. That rules out shrinking the pool
steps (`createPool` + `openPositionFromBase` per asset, 2 tx × N, the
expensive part) for now.

The mint step was a different story, unrelated to any of that: `createMint`
+ `getOrCreateAssociatedTokenAccount` + `mintTo` were three separate
`@solana/spl-token` convenience calls, each sending its own transaction —
not because they needed to, just because each helper is self-contained.
`mintCoinToken` in `solana.mjs` now composes the same four instructions
(`SystemProgram.createAccount`, `createInitializeMint2Instruction`,
`createAssociatedTokenAccountInstruction`, `createMintToInstruction`) into
one legacy transaction by hand. Comfortably under the existing 1232-byte
limit — nothing about this needed the new size increase.

Verified for real on devnet, isolated from the rest of the launch flow:
minted a coin, confirmed via `getSignaturesForAddress` that exactly one
transaction touched the new mint account (previously three), confirmed the
minted supply and ATA balance both match exactly, ~4s end-to-end.

Economically this saves almost nothing (two fewer ~5,000-lamport base fees
— noise next to the ~0.1686 SOL a pool costs) — the value is one fewer
round trip and one less place for a partial failure to happen, not cost.
`MEASURED_MINT_LAMPORTS` in the fee formula wasn't touched; the saving is
too small to matter against its 15% margin.

## First Buy: capped at 10% of supply (2026-09-29)

A creator buying up a large chunk of their own coin's supply right at
launch reads as a rug-pull setup regardless of intent, so First Buy now
refuses anything that would land more than `FIRST_BUY_MAX_SUPPLY_FRACTION`
(0.1, i.e. 10%) of `TOTAL_SUPPLY_WHOLE` in the creator's wallet. Enforced
twice, for different reasons:

- **Before hop 1** (`prepareFirstBuyHop1`): a cheap estimate off a live
  SOL/USD price and the flat starting price (same formula the frontend's
  live estimate uses) — not precise, but catches an obviously-over-cap
  request before it spends any real SOL on the first hop. Skipped (not
  blocked) if the price lookup fails; not authoritative, so failing open
  here is fine — the next check isn't optional.
- **Before hop 2 hands back a signable tx** (`prepareFirstBuyHop2`):
  precise, checked against `swapInternal`'s own simulated output for this
  exact swap — reflects the pool's real current price and liquidity, not a
  guess. `buildFirstBuyTx` in `solana.mjs` now returns `coinAmountOut`
  alongside the transaction specifically so this check can happen before
  any transaction is even built for the client to sign.

Verified on real devnet pools both ways: minted the test creator wallet a
deliberately-large XSOL balance and confirmed hop 2 rejects it against a
fresh pool (`First Buy is capped at 10%...`, no transaction returned), then
reduced the balance to a small amount and confirmed the same pool accepts
it normally.

`/api/launch-config` now also returns `maxFirstBuySupplyFraction` so the
frontend's live estimate can show the same "exceeds the cap" message
without waiting for a round trip, using the same formula — not
authoritative (the server checks are), just avoids surprising the creator
only after they've tried to sign something.

## Metaplex metadata + revoked authorities (2026-09-29)

Prompted by a request to revoke mint/freeze/metadata-update authorities —
turned up that on-chain Metaplex metadata (name/symbol/logo) had never
actually been implemented despite being described in "Where logo + metadata
live" above. Coins minted before this had no on-chain metadata at all —
wallets/Solscan would have shown them as unnamed tokens. Fixed both at
once, since setting up the mint correctly and attaching real metadata are
the same transaction now.

**Where each authority stands:**
- **Freeze authority** — never granted (`createInitializeMint2Instruction`
  already passed `null`). Nothing to revoke; was already correct.
- **Metadata update authority** — never meaningfully granted either.
  `mintCoinToken` creates the Metaplex metadata account with
  `isMutable: false` at creation, so there's no window where it could be
  changed — a create-then-immediately-lock two-step would have the same
  end state but one more thing that could go wrong between the steps.
- **Mint authority** — *is* needed, to mint the fixed initial supply in
  this same transaction, and gets revoked (`createSetAuthorityInstruction`,
  `AuthorityType.MintTokens`, new authority `null`) as the last instruction
  in it. Supply is fixed at `TOTAL_SUPPLY_WHOLE` forever the moment this
  transaction confirms — the platform cannot mint more later even if it
  wanted to.

All six instructions — create account, initialize mint, create ATA, mint
the supply, create metadata, revoke mint authority — are one transaction
(`mintCoinToken` in `solana.mjs`, using `@metaplex-foundation/mpl-token-metadata@2.x`,
the pre-Umi generation, since it exports plain
`web3.TransactionInstruction`-returning functions that compose directly
into the `Transaction` this codebase already builds by hand — no adapter
layer needed). Chose to keep this as *one* transaction rather than split it
because there's no point where "half done" is a safe or recoverable state —
a mint with revoked authority but no metadata, or metadata but a live mint
authority, are both worse than the transaction just not having landed yet.

**Required reordering `launchToken`:** metadata upload has to happen
*before* minting now (the mint transaction needs a real URI to embed), so
`uploadImage`/`uploadMetadata` moved ahead of `mintCoinToken` — previously
the opposite order (mint first, then upload, then patch the DB record).
`uploadImage`/`uploadMetadata` also dropped their now-pointless
`mintAddress` parameter (there's no mint yet at upload time, and the Irys
version never actually used it). Name/ticker byte-length validation
(Metaplex's fixed 32/10-byte fields) moved to the very top of `launchToken`,
before the fee is even broadcast — failing after the fee charged but before
mint would otherwise burn the creator's fee for nothing.

Verified for real on devnet: ran a full launch through the live API (fee →
upload → mint → pool), then independently read back the mint account and
the metadata PDA. Confirmed `mintAuthority: null`, `freezeAuthority: null`,
metadata `isMutable: false`, and `name`/`symbol`/`uri` all match what was
submitted — this is what tools like RugCheck/Solscan check for a token's
"renounced" badges.

## Explore is now a real, shared view of the DB (2026-09-29)

Found while making an unrelated UI tweak: Explore was rendering from
`localStorage` (`PerpsideTokens`, keyed `perpside_launched_tokens`) the
entire time, even though the real backend DB already had every launch's
actual data from day one. That meant a launch only ever showed up in
Explore *in the browser that launched it* — nobody else would ever see it.
`GET /api/tokens` worked and had been tested repeatedly all session; the
frontend just never called it.

Fixed: `PerpsideTokens` is gone. Explore's IIFE now fetches
`GET /api/tokens` (cached client-side, re-fetched on page load and right
after a launch — filter/search still work instantly against the cache, no
re-fetch per keystroke) and maps each row to what `renderCard` expects.
Only `status === 'complete'` rows are shown — a launch still minting, still
creating pools, or that failed partway isn't a real tradeable token yet.

This surfaced two fields Explore's card always expected that the backend
never actually stored:
- **Social links** (`x`/`telegram`/`website`) — captured client-side by the
  form the whole time, but never sent to `/api/launch`. New `x_link`,
  `telegram_link`, `website_link` columns on `tokens`, now populated.
- **Reward model** (Community/Creator/Buyback percentages) — same story.
  New `community_fee`/`creator_fee`/`buyback_fee` REAL columns. Worth being
  clear about what this does and doesn't mean: it's stored so Explore can
  display what a launch is *configured* for, not evidence that any fee
  collection is happening — harvesting and distributing these is still the
  separate, not-yet-built phase this doc has called out since the start
  ("Explicitly deferred").

`cap` (market cap) shown on real cards is `targetFdvUsd` from
`/api/launch-config` for every token — every launch is calibrated to the
same starting FDV, and that's cheap to show. It is **not** a live cap;
computing that for real would mean an RPC round trip per pool per card on
every Explore render, which doesn't scale to a grid. Live pricing on
Explore is an open item, not attempted here.

Verified for real: launched a token through the live API with social links
and a reward-model config set, confirmed it round-tripped through
`GET /api/tokens` exactly as stored, then ran the actual `mapDbToken`
function from `index.html` (not a reimplementation — extracted and executed
verbatim) against that real response and confirmed it produces exactly the
shape `renderCard` expects.

## Starting liquidity is now provably locked (2026-09-29)

Closes the centralization gap the "How It Works" rewrite had just disclosed
(platform holds each position, no on-chain lock): the position NFT is now
burned in the same transaction that opens the position, in
`createPoolAndPosition` (`solana.mjs`).

**Why this works.** Raydium CLMM's `decreaseLiquidity`/`closePosition`
require presenting a token account that holds the position's NFT
(`decreaseLiquidityV2Instruction`'s `nftAccount` param — confirmed by
reading the instruction signature, not assumed) — the on-chain program
checks that account's balance, not some separately-stored owner field.
Burn the NFT to zero total supply and that requirement becomes permanently
unsatisfiable, by anyone, forever. This is the same pattern other
CLMM-based launch platforms use to prove they can't rug a coin's starting
liquidity.

**How it's built.** `openPositionFromBase` is no longer called through its
own `execute()` — its unsigned `transaction`/`signers` are taken directly,
a `createBurnInstruction` for the position NFT is appended, and the
combined transaction is signed and sent as one. The tricky part was
address lookup tables: `openPositionFromBase` compiles its `VersionedTransaction`
against one (confirmed by hitting `Failed to find address lookup table
account` on the first attempt), and `buildProps.lookupTableAddress` — the
field that looked like the right place to read which table — wasn't
reliably populated. Reading the table keys directly off the compiled
message's own `addressTableLookups` instead is what actually worked,
since decompiling needs that information regardless of whether the SDK
surfaces it anywhere else.

Verified for real on devnet: ran a full launch, confirmed via
`getParsedAccountInfo` that the position NFT's supply is `0` and the
platform's own NFT token account is empty — both from the single `openTx`
signature the launch returned, not a follow-up transaction. Then, to make
sure burning the NFT doesn't also break the pool itself (it shouldn't —
NFT ownership only gates LP-management instructions, not swaps),
ran a real First Buy hop 2 swap against that same pool and confirmed it
executed normally: creator's xSOL spent, COIN received. Trading is
unaffected; only decreaseLiquidity/closePosition are now permanently
impossible.

Updated "How It Works" to match — the Overview section states the lock as
fact rather than the Risk section disclosing its absence, and the
Risk & Disclaimers paragraph now separates what's still centralized (who
creates a coin) from what's provably locked (what happens to it after).

## Correction: lock the position, don't burn it (2026-09-29)

The burn approach above was wrong, caught immediately by asking "will fee
collection still work?" — worth keeping both entries rather than editing
history, since the reasoning that led to the mistake and the fix are both
useful. Short version: **burning the position NFT permanently forfeits
that position's trading fees too, with no way to ever recover them** — and
that closes off the Reward Model's fee collection forever, not just for
this beta phase.

**Why.** Raydium CLMM has no pool-level "creator fee" the way CPMM and
Raydium's own Launchpad product do (`collectCreatorFees` /
`claimCreatorFee` — both confirmed to live on those other classes, not
Clmm, by reading the SDK's class methods directly). For a CLMM position,
`decreaseLiquidity` is the *only* way to harvest a position's accrued
trading fees — there's no separate fee-only collect call — and it requires
presenting the position NFT. Burn it, and that requirement becomes
permanently unsatisfiable, by anyone, forever — which was exactly the
point for the principal, but it takes the fees down with it.

**The fix: Raydium's own Lock CL Position program**
(`CLMM_LOCK_PROGRAM_ID`), built for precisely this case.
`raydium.clmm.lockPosition` transfers the position NFT into the lock
program's custody and mints a separate *lock* NFT to the platform as a
claim ticket; `raydium.clmm.harvestLockPosition` uses that claim ticket to
collect the position's accrued fees without ever being able to touch the
underlying liquidity. Same "no one can withdraw this, ever" guarantee as
burning, none of the downside.

**What changed in `createPoolAndPosition`:** `openPositionFromBase` is
back to being executed normally (no more manual transaction
decompile/recompile — that whole approach existed only to append the burn
instruction). Locking happens as a genuine third transaction afterward,
not fused into the open-position transaction — `lockPosition` needs
`ownerPosition`, the *decoded on-chain position account*
(`PersonalPositionLayout.decode`), which doesn't exist to read until the
open-position transaction has already confirmed. A launch with one backing
asset is now 3 platform-signed transactions for that pool (create, open,
lock) instead of 2.

`token_pools` gained a `lock_nft_mint` column — the harvest claim ticket,
needed later whenever fee collection actually gets built.

**Verified for real on devnet, the whole chain:** launched a coin, confirmed
the position NFT (supply 1, untouched) is held by the lock program's PDA
rather than the platform wallet directly, confirmed the platform holds the
lock NFT instead. Ran a real swap against the locked pool to confirm
trading is unaffected. Then, separately, called `harvestLockPosition`
directly against that same locked position and got back a real confirmed
transaction — proving the full lock → trade → harvest cycle actually
works, not just that it compiles.

## Fees pinned to the backing asset, not COIN (2026-09-29)

Prompted by noticing Raydium's UI offers a fee-token choice when creating a
CLMM pool. By default (`createPool`, what this codebase used until now),
a pool's trading fees accrue split across both tokens depending on swap
direction — a COIN→xSOL trade pays its fee in COIN, xSOL→COIN pays in
xSOL. Switched to `createCustomizablePool` with `collectFeeOnMint` set to
the backing asset's mint, so every trade's fee settles in the backing
asset regardless of direction — confirmed directly on Raydium's own
on-chain program source (`fee_on: u8 // 0 = FromInput, 1 = Token0Only,
2 = Token1Only`, in `raydium-clmm/programs/amm/src/states/pool.rs`) by
decoding a real created pool's account and checking `feeOn` matches
whichever side the backing asset landed on.

**Why the backing asset, not COIN.** The backing asset (xSOL/xBTC/xHYPE or
whatever custom token was picked) is liquid and useful to holders the
moment it's collected — a fresh COIN isn't. Buyback & Burn will need a
swap step (backing asset → COIN, immediately before burning) once it's
built, but Community and Creator payouts are better off in the backing
asset directly, and collecting in COIN would've meant *every* reward path
needed a swap, not just Buyback & Burn. Fee collection/distribution itself
is still not built (see "Explicitly deferred") — this only decides what
currency it'll be in once it is.

Verified for real on devnet: launched a coin through the live API with the
new pool-creation call, decoded the resulting pool account directly, and
confirmed `feeOn = 2` (Token1Only) with the backing asset as mintB —
matches intent exactly, cross-checked against the program's own source
rather than assumed from the SDK type alone.

## Metadata update authority actually cleared, not just inert (2026-09-29)

`isMutable: false` (already in place) already meant metadata could never be
changed regardless of who `updateAuthority` pointed at — but the field
itself still showed the platform's own wallet address on-chain, which
looks wrong to anyone (or any tool) checking that field specifically
rather than `isMutable`. Closed the gap.

**First attempt failed, caught by testing rather than trusting the docs.**
Tried `createUpdateMetadataAccountV2Instruction` with `updateAuthority:
null`, expecting Borsh's `COption::None` to clear the field. It didn't —
verified by decoding a real launch's metadata afterward: `isMutable`
correctly flipped to `false`, but `updateAuthority` still showed the
platform's key. Turns out `None` on this field means *"leave unchanged"*,
not *"clear it"* — the field is a plain 32-byte pubkey on-chain, not an
optional type, so there's no "empty" value to set it to via this
mechanism. (A related, separate bug in Metaplex's newer `updateV1`
instruction — reported on GitHub — made this worth verifying rather than
assuming either way.)

**Fix:** reassign `updateAuthority` to `SystemProgram.programId`
(`11111111111111111111111111111111`) instead — the standard convention
for "no one controls this," since it's a valid pubkey that can never
actually sign a transaction as an authority (it's a program, not a
wallet). Both this reassignment and `isMutable: false` have to happen in
the *same* update call, made while the metadata is still momentarily
mutable right after creation — the on-chain program rejects any update
once `isMutable` is already false, including the update that would clear
the authority.

Verified for real on devnet: launched a coin, decoded its metadata, and
confirmed `updateAuthority` reads back as `11111111111111111111111111111111`
with `isMutable: false` — this time actually cleared, not just inert.

## Pool trading fee snapped to the reward model's total, not hardcoded to 0.25% (2026-09-29)

Pools were always created against a single hardcoded `AMM_CONFIG` (0.25%
trade fee), regardless of what the creator set on the Community/Creator/
Buyback sliders at launch. Now the pool's on-chain trading fee tier is
picked to be the closest match to the sum of those three percentages.

**Why "closest match" instead of exact.** Raydium's CLMM fee tiers
(`AmmConfig` accounts) aren't arbitrary — `create_amm_config` is
hard-gated on-chain to a specific admin address
(`address = crate::admin::ID @ ErrorCode::NotApproved`, confirmed by
reading the instruction source directly), so this platform can never
create its own custom-rate config. Only Raydium's own pre-published tiers
can be used, and they're a short, uneven list: devnet has 3
(0.01% / 0.05% / 0.25%), mainnet has 18 (0.01% up to 4%, with gaps — e.g.
nothing between 0.4% and 0.5%, or between 2% and 4%). Each tier also
carries its own fixed `tickSpacing`, which feeds into pool calibration.
Given these constraints, exact matching is impossible in general — the
user explicitly approved nearest-tier rounding as the fallback
(`pickAmmConfig` in `solana.mjs`, picks by absolute distance in
`tradeFeeRate` units, defaulting to the 0.25% tier when no reward
percentage is set).

Both full tier lists are hardcoded from a live fetch of Raydium's own
`api-v3[-devnet].raydium.io/main/clmm-config` on 2026-09-29 — there's no
on-chain "list all configs" call, so this is the same approach Raydium's
own frontend uses.

Verified for real on devnet: minted a coin and created a pool with a 3%
combined reward total (`totalRewardFeePercent`, above every devnet tier),
decoded the resulting pool account, and confirmed it landed on the
expected fallback — devnet's highest tier, 0.25%
(`CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu`), with `tickSpacing = 60`
matching that tier and `feeOn = 2` (still correctly pinned to the backing
asset, unaffected by this change). Devnet can't test the mid-range tiers
this feature is actually for — its own tier list tops out where mainnet's
starts getting interesting — so higher tiers remain unverified until a
real mainnet launch exercises them.

## Launch form: pick a real fee tier, then split 100% of it (2026-09-29)

Previously the three reward sliders (Community/Creator/Buyback) were each
an independent absolute percentage with their own hardcoded caps (3% / 1%
/ 1%) — a holdover from before pool fees were tied to real Raydium tiers
at all. That let a creator configure a combined total (e.g. 5%) nowhere
near any tier that actually exists, silently rounded away by
`pickAmmConfig` server-side with no visibility into what was actually
picked.

Replaced with a two-step model that matches the constraint directly
instead of hiding it:

1. **Trading fee** — a `<select>` populated from a new
   `feeTiers` array on `GET /api/launch-config` (`listFeeTierPercents()`
   in `solana.mjs`, sourced from the same per-cluster tier lists
   `pickAmmConfig` already used). Only real tiers are selectable — nothing
   to round on the way in anymore, though `pickAmmConfig`'s rounding stays
   in place server-side as a defense-in-depth fallback, not the primary
   mechanism.
2. **Community / Creator / Buyback & Burn** — sliders now represent each
   enabled destination's *share of that fee* (0–100), always kept summing
   to 100 across whichever destinations are on. Moving one slider
   redistributes the remainder proportionally across the others; toggling
   a destination on/off re-splits evenly across whatever's left enabled.
   `communityFee`/`creatorFee`/`buybackFee` are still sent to `/api/launch`
   as absolute percentages (`share/100 * totalFeePercent`) — the DB schema
   and backend didn't need to change, only how the frontend arrives at
   those numbers.

Matches the example given when this was requested: a 1% fee split 33% /
33% / 34% now means 0.33% to holders, 0.33% to the creator, and 0.34% to
buyback & burn, out of every trade — not three independently-capped
numbers that happened to add up to something.

Verified in a real browser (Playwright against the local dev server, not
just unit logic): fee tier `<select>` populates from the live
`/api/launch-config` response, defaults to whichever tier is closest to
1%, enabling all three destinations splits them 33.3/33.3/33.3, dragging
sliders to 33/34 lands exactly on a 100 sum, switching the fee tier
updates every "% of volume" label live, and disabling a destination
correctly re-splits the remaining 100% across what's left on — screenshot
confirmed the layout renders cleanly with no console errors.

## Fixed: COIN-as-mintB pools weren't actually single-sided (2026-09-29)

Spotted while checking a user report about pool pair naming ("COIN-xHYPE"
vs "xBTC-COIN" on Raydium's own UI for the same launched coin) — that part
turned out to be expected: Raydium/Uniswap-v3-fork pools always order the
two mints as whichever sorts lower by raw pubkey bytes (`isCoinMintA` in
calibration.mjs), and since COIN's mint is a fresh random keypair every
launch while each backing asset's mint is fixed, which one lands as mintA
vs mintB — and therefore which one a UI lists first — flips per pair. Not
a bug, and not fixable (Solana/Raydium enforce mint0 < mint1 canonically).

Digging into it to be sure turned up a real, separate bug: `initial_price`
for a live launch's three pools showed two tiny fractional numbers (XBTC,
XSOL — coin priced in asset terms) and one wildly different large number
(XHYPE, 5,001,401) — not a display bug, but a sign the *positions*
themselves weren't symmetric. Decoded all three pools on-chain directly:
the two "small number" pools correctly showed `liquidity: 0` at their
starting tick (fully single-sided COIN, price sitting just outside the
position's range, as intended) — but the XHYPE pool showed non-zero
active liquidity, meaning its position was already technically in-range
at creation and holding a sliver of XHYPE alongside the COIN, not the
intended 0%.

**Root cause:** `createCustomizablePool` only accepts a decimal
`initialPrice`, not a raw `sqrtPriceX64` — internally it re-derives its
own `sqrtPriceX64` from that decimal, and the round-trip loses just
enough precision to floor to one tick below whichever boundary tick
`calibratePool` computed. Harmless when COIN=mintA (the position needs
the price *below* its range, and rounding down only pushes it further
outside — already correct). Wrong when COIN=mintB (the position needs the
price *at or above* its range — landing one tick short puts it inside
instead).

**Fix:** `calibratePool` (calibration.mjs) no longer hands back the exact
boundary-tick price and assumes it round-trips correctly. It now resolves
the starting price by running the *same* decimal round-trip
`createCustomizablePool` performs internally (`priceToSqrtPriceX64` →
`getTickAtSqrtPrice`, both from the SDK's own `TickUtil` — the same tick
math the on-chain program uses) and nudges outward by a tick, re-checking,
until the result verifiably lands on the correct side of the boundary.
Verified, not assumed — for either orientation.

Verified twice: (1) reproduced the exact XHYPE scenario's numbers in
isolation and confirmed the round-trip now resolves to tick ≥ tickUpper
instead of one short; (2) minted real test coins on devnet until landing
one that sorts as mintB against XHYPE (~50/50 per mint, matched on the
3rd attempt), created a real pool through the fixed code, and decoded the
resulting on-chain account: `tickCurrent = 154261` (≥ `tickUpper = 154260`)
with `liquidity: 0` — genuinely single-sided this time, matching the
already-correct COIN=mintA case. The earlier live example (whose XHYPE
pool has the dust-liquidity issue) is a devnet demo token with no real
funds at stake and wasn't recreated — the fix only affects pools created
from here on.

## Reward model polish: real spacing, a custom fee-tier picker, mainnet's tiers up to 3% (2026-09-29)

The previous fee-tier pass shipped functional but visually rough:
"Trading fee" and the Community/Creator/Buyback split were crammed into
one `.launch-field`, so the native `<select>`, its hint text, and the
reward toggles had no consistent breathing room between them, and the
native `<select>`'s browser-default styling didn't match the rest of the
form. Three fixes:

1. **Spacing** — split into two separate `.launch-field` blocks ("Trading
   fee" and "Reward model"), each getting the form's standard 1.25rem
   rhythm instead of everything sharing one cramped field.
2. **Custom dropdown** — replaced the native `<select>` with a
   `.fee-tier-select` trigger + floating menu, reusing the same blurred
   dark-panel visual language as the existing wallet/balance menus
   (`.balance-menu`) instead of an unstyleable OS-native control. Opens on
   click, closes on selection or an outside click, marks the active tier.
3. **Mainnet tiers, capped at 3%, regardless of which cluster is live** —
   `listFeeTierPercents` now takes an explicit `{ cluster, maxPercent }`
   instead of always reading the live `CLUSTER`. `/api/launch-config`
   calls it with `{ cluster: 'mainnet-beta', maxPercent: 3 }` unconditionally.
   Devnet's own tier list only goes up to 0.25% — far too narrow for a
   creator to meaningfully configure a reward split against — so the
   picker shows mainnet's real 17 tiers (0.01% – 3%, matching the reward
   model's original ceiling) even while the backend runs on devnet. Once
   `CLUSTER` actually is `mainnet-beta` in production, this becomes the
   live tier list with no code change needed — `pickAmmConfig` (which
   picks the pool's *actual* on-chain tier at launch time) still reads the
   real `CLUSTER`, so devnet launches still round to whichever of its 3
   tiers is closest, same as before; only the picker's displayed options
   changed.

Verified in a real browser (Playwright, local dev server): dropdown
defaults to the tier closest to 1% (lands on exactly 1%, since it's in the
list), shows all 17 mainnet-capped options, opens/closes correctly
including on outside-click, selecting a tier updates the trigger label and
every reward-row's "% of volume" figure, and the layout now has clear,
consistent spacing between the fee-tier picker and the reward split —
confirmed via screenshot, no console errors.

## Reward cron: harvest + Community/Creator/Buyback distribution (2026-09-29)

The reward model's split has existed since launch (see "Explicitly
deferred") but nothing ever actually collected or paid it out — configured
splits were saved and shown, never enforced. This builds that: a
standalone cron (`onchain/server/reward-cron.mjs`, entry point for
`rewards.mjs`) that wakes every 2 hours, checks every complete launch's
*unharvested* pool fees in USD, and once a token crosses $5,000 combined
across its pools, harvests each pool and splits the proceeds into
Community (sent to every real holder, proportional to their balance),
Creator (single transfer), and Buyback & Burn (swap to COIN, then burn) —
using the same ratio the creator configured at launch time.

**Key decisions (confirmed with the user before building):** all three
destinations run in the same cron, not just Community. Each pool's
harvested fee is distributed natively in its own backing asset (xSOL fees
stay xSOL, xBTC stay xBTC, etc.) rather than swapping everything into one
currency — no extra swap risk in an unattended job. Holders below $1 of
computed share are skipped (ATA rent + tx fee would cost more than the
payout); the skipped amount stays in the platform's wallet rather than
being reharvested later, since a locked position's harvest is all-or-
nothing — there's no partial amount left sitting in the pool to catch on a
future pass.

**Reading fees before spending a transaction to collect them.** A locked
position's `tokenFeesOwed*` fields are a stale cache, only updated when
the position is touched — the real pending amount needs computing live
from the pool's `feeGrowthGlobal` and the two boundary ticks'
`feeGrowthOutside` (`PositionUtils.GetPositionFees` in the SDK, the same
math the on-chain program uses). Verified for real: generated actual fee
accrual with a real swap, read the predicted pending amount, then
harvested and diffed the platform's ATA balance — the harvested amount
matched the predicted amount exactly, both before and after fixing a
missing `clmmProgram` param on devnet (`harvestLockPosition` silently
defaults it to the *mainnet* CLMM program if omitted, which throws
`InvalidProgramId` against a devnet pool).

**Finding real holders.** `getProgramAccounts` filtered by mint + 165-byte
account size returns every token account for a mint — but for a freshly
launched coin, the *largest* of those are its own pool vaults (each pool
holds a third of supply as single-sided launch liquidity), not real
holders. Confirmed on a real launched coin: 3 of 4 token accounts were
owned by the token's own `pool_address` values, the 4th was dust left in
the platform's own wallet from testing. `getRealHolders` excludes both —
every one of a token's own pool addresses, and the platform wallet —
before computing anyone's share.

**Idempotent, resumable by design — not just in theory.** Three new
tables (`reward_runs` / `reward_run_pools` / `reward_payouts`) track every
step, and every payout function checks what's already persisted before
sending anything: the *first* call for a pool computes and inserts
`'pending'` rows before sending, every call after only resumes rows still
`'pending'`, never recomputes shares (holder balances can shift between
attempts) or re-inserts (which would double-pay). This was caught by
testing, not designed defensively in the abstract: an early version
re-derived and re-inserted payouts on every call, and a real end-to-end
test — mint a coin, fund 3 wallets, have them buy in, generate real fee
volume, harvest, distribute — hit a genuine transient `fetch failed`
during the buyback step *after* Community and Creator had already
succeeded. Retrying with the naive version would have re-sent both.
Rewrote so each of the three payout kinds is checked independently before
acting, added `harvested_amount != null` (not a status string) as the
signal for "already harvested," and included `'failed'` runs in what gets
picked up for retry (safe now that every step underneath is idempotent).
Reran the exact same scenario: the retry reused the same run and pool
rows, did not re-harvest, left the two already-`'sent'` Community/Creator
payouts untouched, and completed only the stuck buyback — confirmed by
inspecting the DB rows directly, not just by the run finishing without an
error.

**Split math.** A pool's harvested amount splits into Community/Creator/
Buyback using the *ratio* between the token's stored
`community_fee`/`creator_fee`/`buyback_fee` (which the launch form already
constructs to always sum to the pool's real on-chain trade fee — see the
"pick a real fee tier, then split 100% of it" entry above), computed with
scaled-integer arithmetic rather than floats, and Buyback takes the
remainder (`harvested - community - creator`) rather than its own
ratio'd slice, so integer-division truncation can't strand a few atomic
units unaccounted for.

**Deployment.** Runs as its own Railway service (`reward-cron`, cron
schedule `0 */2 * * *`), not folded into the main API service — a stuck
reward run can't take the site down, and a site deploy can't interrupt a
distribution mid-flight. Shares the main service's persistent volume
(`/data`, same `DB_PATH`) so it reads/writes the same SQLite database;
Railway's IaC tool (`.railway/railway.ts`) confirmed this is a clean,
scoped change — `railway config plan` showed exactly two fields changing
on the new service (`deploy.cronSchedule`, `deploy.startCommand`, and the
volume attachment) and *zero* changes to the live `perpside` service.
Applying it did surface one more thing worth a re-plan before trusting it
blindly: Railway auto-sets `restartPolicyType: NEVER` on a cron service
(correct — a cron job should run once and exit, not be restarted forever
like a normal service), but that field wasn't declared in the authoring
file, so the *next* plan proposed reverting it back to unset. Pinned it
explicitly in `railway.ts` rather than applying that drift.

## Token detail page: replaces the Explore-card → Jupiter redirect (2026-09-29)

Clicking a coin in Explore used to `window.open` straight to
`jup.ag/tokens/<mint>` — no way to see a coin's own info without leaving
the app. Now it opens an in-app page (`showTokenDetail(mint)`, a new
`page-token` `.page` section, same show/hide/back-button pattern as
Launch and How It Works) with the coin's image/name/ticker, copyable mint
address and creator wallet, social links, its backing assets, its
configured reward model, and — the actual point of this — real
tokenomics: how much has actually been distributed to the community, sent
to the creator, and burned, not just what's configured. A prominent
`Trade` button (styled like the site's own primary CTA, `.sign-in`) is
still the only way to actually swap — it opens Jupiter, same as before,
just no longer the *only* thing a click does.

**Where the tokenomics numbers come from.** New `GET /api/tokens/:mint`
field `rewardTotals` (`db.mjs` `getTokenRewardTotals`), summing every
*successfully sent* (`status = 'sent'`) row in `reward_payouts` — pending,
skipped-dust, and failed payouts don't count, since they didn't actually
happen. Community and creator totals are kept separate per backing asset
(a coin with 3 pools can have paid out in 3 different currencies — see
the reward cron's own "native, not swapped" design) rather than merged
into one number. Burned amount needed a schema addition: the existing
buyback payout only ever recorded the *backing-asset* amount that went
into the swap (needed to resume a stuck buyback with the exact original
input), never the *COIN* amount that came back out and actually got
burned. Added `reward_payouts.secondary_amount`, populated only for
buyback rows via a new `markRewardBuybackSent`, so "how much has been
burned" has a real number to read instead of only being visible by
decoding the burn transaction by hand.

Verified in a real browser (Playwright, local dev server, a token seeded
with real `reward_payouts` rows across all three kinds): page renders
correctly from Explore, back button returns to Explore, copy-to-clipboard
works on both addresses, reward-model and tokenomics figures match the
seeded DB rows exactly, mobile layout (390px) stacks cleanly with a
full-width Trade button. Caught and fixed one real bug from this pass —
number formatting used `toLocaleString(undefined, ...)`, which renders
with a comma decimal separator under some browser locales; forced
`'en-US'` explicitly so it's consistent with the rest of the site
regardless of a visitor's locale.

## Token detail page, round 2: it read as too plain (2026-09-29)

First version was functionally complete but visually flat — three
same-weight cards of label/value rows, no real hierarchy, nothing that
made a coin's own page feel like *its* page rather than a generic
settings panel. Reworked the same data into:

- A banner at the top using the coin's own image (blurred, darkened) as
  the background, or one of Explore's gradient pairs when there's no
  image — same technique Explore already uses for image-less cards, so a
  coin without art still gets a colored, non-empty banner. Market cap
  now shown here too (previously missing from the page entirely, despite
  being the first thing Explore's own cards lead with).
- Reward model as a stacked split bar + colored legend instead of three
  plain rows — reads as "who gets what share" at a glance instead of
  needing to compare three separate numbers by hand.
- Tokenomics as icon-led stat tiles (people icon/community, person
  icon/creator, flame icon/buyback) with a big USD headline number per
  tile and the exact per-asset amount as a sub-line, instead of the same
  label/value row style used for static config elsewhere on the page —
  the whole point of this section is "real money moved," so it gets the
  visual weight a dashboard stat gets, not a settings row. USD figures
  come from each backing asset's own price (`/api/backing-assets`,
  already fetched) rather than adding a new pricing dependency.

Backing assets got a small upgrade too (icon + symbol + approximate
share of supply per pool row) instead of a single bare pill, since a
whole card for one small badge was part of what read as empty.

Verified the same way as round 1 — real browser, real seeded payout
data (this time across two backing assets, to check the multi-asset
tile sub-line renders correctly) — plus a fresh mobile screenshot, since
the whole layout changed.

## Platform revenue cut: 10% off the top of every harvest (2026-09-30)

The reward cron previously split 100% of a harvested pool's fees across
Community/Creator/Buyback. Added a platform cut on top: 10% of every
harvest now goes to a fixed revenue wallet
(`7qRCnebUspWNLEFbmgcvWrrJq28gHV8CjdqPfshpZxfj`) *before* the
Community/Creator/Buyback split runs — that split now runs against the
remaining 90%, not the full harvested amount. Implemented as a fourth
payout kind (`'platform'`) in `reward_payouts`, following the same
idempotent-resume pattern as the other three (checks for an existing row
before sending, so a retry after a later step fails doesn't re-send the
platform cut).

Verified end-to-end on real devnet: minted a coin, generated real fee
volume, ran the cron, and confirmed by reading the revenue wallet's
actual on-chain balance (not just the DB row) that it received exactly
10% of the harvested amount — 388 out of 3884 atomic units — landing
*before* the creator/buyback transactions in `reward_payouts`'
insertion order, with the remaining 90% (3496) splitting into
community/creator/buyback at the token's configured ratio exactly as
expected (1398/699/1399).

## Platform wallet secret now accepts base58, not just a JSON byte array (2026-09-30)

`PLATFORM_WALLET_SECRET` only ever accepted a JSON array string
(`[1,2,3,...]`) — what a secrets manager would typically inject, but not
what a wallet like Phantom actually exports when you ask it for a
private key (a base58 string). The real platform key for the mainnet
rollout was set as base58, so `getPlatformWallet()` needed to handle
both. `parseSecretKey()` now detects the shape (`[` prefix → JSON array,
otherwise base58 via the `bs58` package, added as a direct dependency
rather than relying on it being present transitively through
`@solana/web3.js`) instead of assuming one. `devnet-wallet.json`'s own
format is untouched — this only changes what the env var accepts.

Verified with synthetic keypairs, not just reasoning about the code: a
fresh `Keypair.generate()`'s secret round-tripped correctly through both
`parseSecretKey` paths (base58 and JSON array), and the existing
`devnet-wallet.json` fallback still resolves to the known platform
address with the env var unset — confirming this is additive, not a
change to the existing paths.

## Cron crash root-caused: CLUSTER flipped to mainnet-beta with RPC_URL still devnet (2026-09-30)

Reward cron was failing every token with `Cannot read properties of null
(reading 'data')` — an unhelpful crash from `getPoolPendingFees` calling
`.data` on `connection.getAccountInfo(...)` without checking for null
first. Reproduced directly (SSH into the live `perpside` container,
which shares the same DB/env shape as `reward-cron`, and ran
`reward-cron.mjs` by hand instead of waiting for the next scheduled
tick) rather than guessing from the stack trace alone.

Root cause: production's `CLUSTER` had been switched to `mainnet-beta`
while `RPC_URL` was still pointing at the devnet Helius endpoint. Every
PDA in `getPoolPendingFees`/`harvestPoolFees` is derived with
`CLMM_PROGRAM_ID_FOR_CLUSTER`, which follows `CLUSTER` — so with
`CLUSTER=mainnet-beta`, it derived *mainnet* program-owned addresses,
then queried them against the *devnet* RPC, where they've never existed.
`getAccountInfo` correctly returned `null` for an address that
genuinely doesn't exist there; the bug was not checking for it.

Two-part fix:
- The two DB rows this actually broke were devnet test tokens
  (`deBridge Mascot`, `Perpside`/PRPS) that have no business surviving
  the mainnet cutover anyway — deleted directly from the production DB
  (`tokens`, `token_pools`; `reward_payouts`/`reward_run_pools`/
  `reward_runs` were already empty, the cron had never gotten far enough
  to write any).
- `getPoolPendingFees` and `harvestPoolFees` now throw a specific,
  actionable error ("pool account not found for X on Y — likely a stale
  row from a different cluster") instead of the bare null-dereference,
  and `solana.mjs` warns at startup if `CLUSTER=mainnet-beta` is paired
  with an `RPC_URL` that still looks like a devnet endpoint — this exact
  misconfiguration should be visible in the first log line next time,
  not discovered by every cron tick failing silently-ish for weeks.

**Still an open problem, not fixed by this pass:** `RPC_URL` in
production is still the devnet Helius endpoint. With `CLUSTER` now
`mainnet-beta`, this doesn't just affect the cron — `launchToken` itself
would try to mint/create pools under mainnet program IDs and broadcast
against a devnet RPC, which cannot work. The site is effectively unable
to complete a real launch until `RPC_URL` is pointed at an actual paid
mainnet RPC endpoint (see "What's needed for mainnet" — this was always
called out as a separate blocker from the backing-assets/wallet-funding
work, and still is).

## Back-button bug: single "previous page" slot, not a real stack (2026-09-30)

Reported: open a coin's page from Explore, go to How it Works, then hit
Back twice — instead of unwinding to Explore, the second Back bounced
right back to How it Works. Root cause was `window.__perpsidePrevAppPage`
— a single slot, not a stack. `showAppPage(name)` unconditionally set it
to whatever page was being *left*, including when that "navigation" was
itself a Back click. So Token → How (prev='token') → Back (prev='how',
now showing token) → Back (prev='token' again, now showing how) — ping-
ponging between the last two pages forever instead of continuing to
unwind, the moment there were two forward navigations in a row.

Replaced with `window.__perpsideAppStack`, a real array. `showAppPage`
pushes onto it when navigating to a genuinely new page; `goBackFrom` pops
the current page off first, then calls `showAppPage` with whatever's now
on top — which `showAppPage` sees as already equal to the stack's top and
correctly doesn't re-push. 'landing' can be an entry in the same stack
(reset there by the two entry points that need it — the landing hero's
"Launch" button and the "How it Works" landing link) even though it isn't
one of the `.page` elements `showAppPage` renders; `goBackFrom` pops it
too and hands off to `showLanding()` when it's on top.

Verified in a real browser, not just by re-reading the logic: reproduced
the exact reported sequence (Explore → Token → How it Works → Back →
Back) and confirmed it now unwinds to Explore instead of bouncing: stack
went `['earn'] → ['earn','token'] → ['earn','token','how'] →
['earn','token'] → ['earn']`. Also checked both landing-entry paths
(hero "Launch" button, footer "How it Works" link) still return to
landing correctly, and a deeper four-level chain (Explore → Token → How →
Launch, three Backs) unwinds one page at a time exactly as expected.

## Graduation, part 1: pre-market CLMM pool + CPMM final pools, building blocks (2026-09-30)

Prompted by the price-ceiling question above: a single-sided CLMM range
always has a hard ceiling (the position runs out of COIN to sell once
price sweeps the whole range), and with a fixed total supply that means a
fixed maximum FDV per launch (~20x the starting FDV, confirmed
empirically earlier). Two decisions to fix this, from the user, replacing
the current "3 CLMM pools live immediately at a fixed $5,000 target FDV"
model entirely:

1. **Pre-market**: at launch, one single-sided CLMM position, COIN paired
   against native SOL — not locked, since graduation needs to close it.
   Sized to replicate pump.fun's own real numbers rather than inventing
   new ones: 793,100,000 COIN (79.31% of supply) committed to the
   position, calibrated so full depletion yields ~85 SOL, starting at
   pump.fun's own implied price (30 virtual SOL / 1.073B virtual tokens).
   Confirmed against pump-fun-sdk's own bonding-curve-math.md rather than
   memory. The other 206,900,000 COIN (20.69%) stays in reserve for
   graduation.
2. **Final pools are standard Raydium AMM (CPMM), not CLMM** — deliberate,
   specifically so there's no tick range and therefore no ceiling: a
   constant-product pool's price can run arbitrarily high as one side
   depletes, asymptotically, with no hard wall. Graduation deposits real
   two-sided liquidity (the reserved COIN + whatever backing asset the
   raised SOL bought), so there's no single-sided calibration to do at
   this step at all — just a normal liquidity add.

**calibratePreMarketPool (calibration.mjs).** Unlike calibratePool's
`ceilingMultiplier` (an arbitrary, independently-chosen range width), here
the range width is *solved for*: given a fixed COIN amount and a fixed
target SOL raise, there's exactly one range width that hits it. Solved by
bisection against the SDK's own `getLiquidityFromAmountA` /
`getDeltaAmountBUnsigned` — not a hand-derived closed form — so a mistake
shows up as "didn't converge" rather than a silently wrong pool. First
version of the bisection had a real sign bug in the `coinIsMintA=false`
branch (searched in the wrong direction, converged to a nonsense multi-
billion-SOL answer) — caught by testing both orientations, not just one;
fixed by tracking "narrow"/"wide" range bounds directly instead of lo/hi
with a per-orientation sign flip. Verified: both orientations now converge
to within 0.05% of the 85 SOL target.

**createPreMarketPool (solana.mjs).** Same createCustomizablePool +
openPositionFromBase pattern as the existing createPoolAndPosition, minus
the final lockPosition call — the position NFT stays in the platform
wallet's own ATA, closable later. Verified on devnet: pool decodes with
`liquidity: 0` at the current tick (genuinely single-sided, price sitting
exactly on the boundary) and the position NFT confirmed sitting in the
platform wallet, not sent to any lock program.

**createCpmmPoolAndLock (solana.mjs) + pickCpmmConfig.** CPMM has its own
separate fee-config system from CLMM's AMM configs — fetched live from
`api-v3[-devnet].raydium.io/main/cpmm-config` the same way the CLMM list
was. Notable: `creatorFeeRate` is a *separate* protocol-native fee, not a
slice of `tradeFeeRate` (some tiers have `creatorFeeRate` exceeding
`tradeFeeRate` — confirmed from Raydium's own numbers, not assumed) and
claimable directly via `collectCreatorFees`/`collectCreatorFeesPermissionless`
— likely replaces the reward cron's custom-built Creator-payout logic
entirely once the harvest side is adapted (not done yet, see below).
Locking uses CPMM's own Lock LP program (`lockLp`/`harvestLockLp`) — the
fungible-LP-token equivalent of CLMM's Lock CL Position program, same
"nobody can withdraw the underlying liquidity, ever" guarantee. Verified
end-to-end on devnet: created a real dual-sided pool (COIN + a backing
asset), locked 100% of the resulting LP tokens, confirmed the platform's
LP balance is exactly 0 afterward.

**Not done yet, tracked for the next pass:** actually closing the
pre-market position at graduation (decreaseLiquidity + closePosition) and
extracting its SOL; splitting that SOL and swapping into backing assets;
a cron to detect a depleted pre-market position and trigger graduation;
adapting the reward cron's harvest/distribution logic from CLMM's
`harvestPoolFees`/`getPoolPendingFees` to CPMM's `harvestLockLp`/
`collectCreatorFees`; DB schema for pre-market pools and a
premarket→graduating→complete status flow; removing the old
fixed-$5,000-FDV immediate-3-CLMM-pool code path from launch.mjs now that
it's being replaced, not just added alongside. Frontend explicitly out of
scope for this pass per the user.
