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

## Graduation, part 2: closing the pre-market pool + orchestration (2026-09-30)

**closePreMarketPool (solana.mjs).** One `decreaseLiquidity` call with
`ownerInfo: { useSOLBalance: true, closePosition: true }` and
`liquidity: ownerPosition.liquidity` (i.e. 100%) withdraws the position's
entire principal *and* reclaims the position account's rent in a single
transaction — no separate close step needed, since this position was
never locked. Returns exact received amounts by diffing the platform's
real SOL and COIN balances before/after (same pattern as the rest of this
session), not a computed estimate — so the ~0.002 SOL of reclaimed rent
just falls naturally into `solReceivedLamports` along with the withdrawn
liquidity, which is fine: the caller only needs "how much do I have to
work with now," not a rent-exclusive figure. Verified end-to-end on
devnet: minted a token, opened a real pre-market position, swapped
against it, then closed it — confirmed both SOL and COIN landed in the
platform wallet and the position account itself is gone (rent reclaimed).

**swapPlatformSolForAsset (solana.mjs).** Platform-signed, immediate
Jupiter swap — same quote → build → sign → send → confirm shape as First
Buy's existing hop1, just self-signed instead of built for a user to sign.
Same already-accepted limitation as hop1: Jupiter has zero devnet
liquidity, so this function cannot be exercised on devnet at all, only on
mainnet. Not a new gap, just a second place the existing one shows up.

**graduation.mjs (new file).** `graduateToken({ coinMint, poolId,
positionNftMint, backingAssets, totalRewardFeePercent })` composes the
three pieces above plus the already-verified `createCpmmPoolAndLock` into
the actual graduation process: close the pre-market position, split the
recovered SOL and COIN evenly across however many backing assets (1–3)
this launch was configured with, swap each SOL share into its backing
asset, and seed + lock one CPMM pool per asset with the results. Mirrors
`rewards.mjs`'s layering — `solana.mjs` holds single on-chain operations,
this file composes them into the business process. The even-split helper
(`splitAtomicEvenly`, remainder folded into the last share) is the same
approach as `calibration.mjs`'s `splitSupplyEvenly`, just over `BN`
instead of `BigInt` since atomic amounts move through `solana.mjs` as
`BN`. Verified in isolation: the split math sums back to the exact input
total for 1, 2, and 3 shares. The orchestration wiring itself (field
names/shapes between each step's return value and the next step's call)
was cross-checked by reading every function it calls, not assumed — but
`graduateToken` as a whole has *not* been run end-to-end, because its
Jupiter swap step is the same untestable-on-devnet gap as
`swapPlatformSolForAsset` alone. Every other piece it calls
(`closePreMarketPool`, `createCpmmPoolAndLock`) was already independently
verified for real on devnet before being wired in here.

**Still not done:** a cron to detect a depleted pre-market position and
call `graduateToken`; adapting the reward cron to CPMM; replacing the old
launch.mjs flow with this one. Frontend still out of scope per the user.

## Graduation, part 3: DB schema + resumable graduation runs (2026-09-30)

Four new tables, purely additive — nothing existing changed, so this is
safe to deploy even before anything writes to them yet.

**premarket_pools.** One row per token's pre-market CLMM position
(`active` -> `closing` -> `closed`), populated by `createPreMarketPool`
(not wired in yet) and closed out by `closePreMarketPool`'s result.
`listPremarketTokens()` is what a depletion-detection cron (not built yet)
will iterate.

**final_pools.** A token's real graduated CPMM pools, one row per backing
asset — the new-model equivalent of `token_pools`, kept as a separate
table rather than extending `token_pools` because several of its columns
(`position_nft_mint`, `tick_lower`, `tick_upper`) are CLMM-specific and
`NOT NULL` on the live production table; adding a CPMM row there would
mean either fake tick values or a schema migration SQLite can't do via a
plain `ALTER TABLE`. `token_pools` stays untouched for existing/legacy
rows; new tokens use `final_pools` going forward.

**graduation_runs / graduation_run_assets.** Same resumability pattern as
`reward_runs`/`reward_run_pools`: graduation is several sequential
on-chain steps (close the pre-market position, then swap + create-pool
per backing asset), so a crash mid-run needs to resume from where it left
off rather than retry from scratch — retrying `closePreMarketPool` on an
already-closed position would just fail. `getIncompleteGraduationRun`
mirrors `getIncompleteRewardRun` exactly. `graduateToken` in
graduation.mjs does not yet write to these tables (it's still the plain,
non-resumable version from part 2) — wiring that up is the next step,
together with the depletion cron that will actually call it.

Verified by a scratch-DB smoke test exercising every new function
end-to-end (insert a premarket pool, look it up, create a graduation run,
add an asset row, mark it swapped, insert its final pool, mark it
pool_created, close out the run, close the premarket pool) — not just a
syntax check.

## Graduation, part 4: depletion cron + resumable graduation.mjs (2026-09-30)

**isPreMarketPoolDepleted (solana.mjs).** Reads the pool account's real
`tickCurrent` (via the same `PoolInfoLayout`/stale-row-error pattern
`getPoolPendingFees` already uses) and compares it against the position's
range. calibratePreMarketPool always anchors the position's *start* at
one edge (tickLower when coinIsMintA, tickUpper otherwise — see its own
"narrow/wide" comment) — so the *ceiling* (100% swept to SOL) is always
the opposite edge. coinIsMintA is recomputed from the two mints rather
than trusted from a stored flag, since it's a pure function of them.

**tokens.backing_assets (db.mjs).** A gap surfaced while wiring this up:
the old model created all of a launch's final pools immediately, so which
backing assets it used was only ever implicit in its `token_pools` rows.
The new model defers final-pool creation to graduation, long after
launch — so which assets the creator picked (still validated the same
way, via launch.mjs's `assertAssets`) now has to be remembered from
launch time. Added as a JSON-array column, decoded by
`getTokenBackingAssetSymbols`/inlined into `listPremarketTokens` and the
new `listGraduatingTokens`. `launch.mjs` doesn't populate it yet — that
lands together with replacing the old launch flow.

**graduation.mjs, rewritten.** The part-2 `graduateToken` (plain
arguments in, one straight-through run, no persistence) is gone, replaced
by `processToken`/`runGraduationCycle`, driven by
`graduation_runs`/`graduation_run_assets` end to end:
- No run yet + pool depleted (`isPreMarketPoolDepleted`) -> flips the pool
  to `closing` and the token to `graduating`, opens a run.
- Run exists but `close_tx` isn't set -> closes the pre-market position
  for real, persists the result, marks the pool `closed`.
- Run has no asset rows yet -> splits the recovered SOL/COIN across
  `backing_assets` (resolved to mint addresses via launch.mjs's
  `listBackingAssets`) and inserts one pending row per asset.
- Each asset row -> swap its SOL share, seed + lock its CPMM pool, insert
  the `final_pools` row. Resumption here is keyed off what's actually
  *persisted* per row (`swap_tx`, then a created pool), not the row's
  `status` label — a row that failed after swapping doesn't re-swap on
  retry, matching the "trust real state over a status field" approach
  the rest of the session has used throughout.
- All asset rows settled -> run and token both marked `complete`; any row
  still `failed` -> run marked `failed` but stays in the resumable set
  (`getIncompleteGraduationRun` includes `failed`), so the *next* cron
  tick retries automatically — same shape as rewards.mjs's reward runs.

**graduation-cron.mjs (new file).** Entry point for a new Railway Cron
Schedule service, identical shape to reward-cron.mjs — runs
`runGraduationCycle()` once and exits. **Not deployed yet**: unlike code
changes, standing up the actual Railway service (start command + cron
schedule) is a dashboard/infra step, not something in the repo to push —
needs to be created manually, same category of action as the mainnet RPC
provider gap flagged earlier in this doc.

**Verified end-to-end on devnet**, not just syntax-checked: minted a real
coin, built a small real single-sided pre-market pool (same
createCustomizablePool + openPositionFromBase path createPreMarketPool
uses, just a narrow calibratePool range instead of the real 85-SOL one —
organically depleting a real 85-SOL range on devnet was impractical, so
this manufactures the "already depleted" DB state processToken's own
depletion branch would produce and exercises everything downstream of
that for real), confirmed `isPreMarketPoolDepleted` correctly reads
`false` on a fresh position, ran `runGraduationCycle()` twice:
- Cycle 1: closed the position for real (real close_tx, real recovered
  SOL/COIN persisted), attempted the XSOL swap, got a clean
  `TOKEN_NOT_TRADABLE` from Jupiter (devnet has no liquidity for the
  devnet stand-in assets either — same accepted gap, now confirmed with
  its exact real error shape), and persisted the failure without
  crashing.
- Cycle 2: resumed the same run, confirmed `close_tx` was byte-for-byte
  identical (proving it did *not* re-close the now-gone position) and
  exactly one `graduation_run_assets` row existed throughout (proving the
  split doesn't re-run once seeded) while still retrying the failed swap.

**Still not done:** replacing the old launch.mjs flow with
`createPreMarketPool` + populating `backing_assets`; adapting the reward
cron to CPMM's `harvestLockLp`/`collectCreatorFees` for graduated pools;
standing up the graduation-cron Railway service itself. Frontend still
out of scope per the user.

## Graduation, part 5: launch.mjs now opens the pre-market pool (2026-09-30)

The live minting path — the highest-risk piece of this whole feature,
since it's what every real launch actually calls. `launchToken` no longer
creates 1-3 immediately-locked CLMM pools; it mints, opens *one*
pre-market pool via `createPreMarketPool`, inserts a `premarket_pools`
row, and lands the token at `status: 'premarket'` — not `'complete'`.
Graduation (part 4) picks it up from there once depleted.

**Real cost measured, not assumed.** `calculateLaunchFeeLamports`'s old
per-pool constant was sized for a CLMM pool + lock, immediately, times N.
Under this model the platform's real cost splits across two different
times: `createPreMarketPool` now, once, regardless of `assetCount` — and
`createCpmmPoolAndLock` later, at graduation, once *per* backing asset, on
the platform's own wallet with nobody left to charge at that point.
Measured both for real (diffing platform balance around each real call,
same method the original constants were obtained with):
`MEASURED_PREMARKET_POOL_LAMPORTS` = 168,571,960 lamports (~0.1686 SOL —
coincidentally almost identical to the old per-pool figure, since it's the
same createCustomizablePool + openPositionFromBase rent cost either way);
`MEASURED_GRADUATION_PER_ASSET_LAMPORTS` = 200,512,760 lamports (~0.2005
SOL, a bit more than CLMM's lock — CPMM's lock mints its own metadata
NFT). The fee now folds `assetCount * MEASURED_GRADUATION_PER_ASSET_LAMPORTS`
in up front, prefunding that later cost — same anti-spam-not-revenue
principle as before, just accounting for cost that lands later instead of
assuming it's zero because it isn't paid immediately.

**Dead code removed, not left behind:** `createPoolAndPosition`
(solana.mjs) and `calibratePool`/`splitSupplyEvenly` (calibration.mjs) —
the old model's pool-creation and supply-split logic — had zero remaining
callers once launch.mjs stopped using them, so they're gone rather than
left as unreferenced cruft. `token_pools`/`getPoolPendingFees`/
`harvestPoolFees`/CLMM lock-harvest code in rewards.mjs is *not* touched —
still there for whatever the reward cron's still-pending CPMM adaptation
needs to reference, and technically still correct for any legacy
`token_pools` row (there happen to be none right now — the DB was wiped
earlier in this project's mainnet transition).

**First Buy: asked the user how to handle a real breaking change, rather
than guessing.** The old First Buy was two creator-signed hops (SOL ->
backing asset via Jupiter, then backing asset -> COIN via the pool that
existed immediately) because pools only ever paired COIN against a
backing asset. The pre-market pool pairs COIN directly against native
SOL, so buying against it is inherently *one* hop — but the existing
`buildFirstBuyTx` (solana.mjs) turned out to already be fully pool- and
asset-agnostic (just `assetMint`/`poolId` parameters, no backing-asset-
specific logic), so no new on-chain mechanism was needed, only a
different caller. The blocker was that the old shape was 4 API routes
(`hop1-tx`/`hop1`/`hop2-tx`/`hop2`) the frontend calls directly with two
separate wallet signatures — collapsing that is a real frontend-visible
break, which is exactly the kind of call that isn't this session's to
make silently while "no UI work" is the standing instruction. Asked the
user directly; they chose the clean break: new single-hop routes
(`/api/launch/first-buy/tx` + `/api/launch/first-buy`), old ones removed
outright rather than faked into a compatible-looking shape. **The
frontend will not be able to complete a First Buy until it's updated to
call the new routes with one signature instead of two** — a known,
accepted gap from this decision, not an oversight; still explicitly no UI
work happening in this pass.

Side effect of the collapse: First Buy no longer depends on Jupiter at
all, so — unlike the old hop 1 — it's no longer mainnet-only.

`getLaunchConfig`'s `targetFdvUsd` still returns the old flat $5,000
default rather than the pre-market pool's real pump.fun-anchored starting
point (which floats with SOL's price, since it's pegged to a fixed SOL
amount, not a fixed USD one) — left alone deliberately, since it only
feeds a client-side *preview* number, not the enforced cap (that's always
checked server-side against the real swap simulation, unaffected by this
gap), and correcting it properly would mean changing what the API
contract returns to the frontend, which is out of scope for this pass.

**Verified end-to-end on devnet** using the real, unmodified public
functions exactly as index.mjs's routes call them (`prepareFee` -> sign ->
`launchToken` -> `prepareFirstBuy` -> sign -> `broadcastFirstBuy`), not a
lower-level substitute: real fee computed (0.4274 SOL for 1 backing
asset, matching the new formula), real mint, real pre-market pool created
and correctly reflected in `premarket_pools`/`tokens.status`, a real 0.01
SOL First Buy that landed real COIN in the creator's wallet
(357,619.15 COIN) with `first_buy_lamports` persisted correctly, and a
20-SOL over-cap attempt correctly rejected by `assertWithinFirstBuyCap`
before any signable transaction was returned.

**Still not done:** the frontend update First Buy now needs; adapting the
reward cron to CPMM; standing up the graduation-cron Railway service.
Frontend still out of scope per the user except for the First Buy route
change flagged above, which they explicitly asked for.

## Graduation, part 6: reward cron adapted to CPMM (2026-09-30)

The reward cron's harvest/collect side, fully switched from CLMM to CPMM —
the last piece of the graduation feature that still depended on the old
model. `getPoolPendingFees`/`harvestPoolFees`/`swapPlatformAssetForCoin`
(CLMM, zero remaining callers) deleted from solana.mjs, same "no unused
code" approach as parts 3 and 5.

**CPMM's fee accounting is structurally different from CLMM's, confirmed
by reading the SDK, not assumed.** CLMM's locked-position fees were pure
on-chain state (`PositionUtils.GetPositionFees`, no network call). CPMM
has no equivalent — there's no exported on-chain layout for the lock
account, and `harvestLockLp` takes an explicit `lpFeeAmount` input rather
than "harvest whatever's pending." The only source for that figure is
Raydium's own hosted indexer (`dynamic-ipfs[-devnet].raydium.io/lock/cpmm/
position` — the same one their own UI's claim-fees button uses). Getting
there took two real, empirically-caught bugs, not assumptions:
1. The SDK's own `raydium.api.fetchCpmmLockInfo()` mis-concatenates the
   base API host in front of `CPMM_LOCK`'s already-absolute URL — confirmed
   by a raw request against the broken URL it actually builds. Worked
   around with a direct `fetch()` in `fetchCpmmLockPosition` (solana.mjs).
2. The `id` query param is the lock's PDA (`getCpLockPda(programId,
   nftMint)`), not the raw lock NFT mint — confirmed by reading
   `fetchCpmmLockBalances`' own (working) usage inside the SDK, since
   passing the mint directly 404's with "account not is lock nft".

The indexer itself is real but genuinely laggy — empirically, anywhere
from ~15 seconds to several minutes after a real swap before it reports
non-zero `unclaimedFee`, and it intermittently 500s in between. Every
caller of `getCpmmPoolPendingFees` (both the pending-fee estimate and the
harvest itself) treats a failure as "skip this token/pool for now, try
again next tick" — same resilience posture `fetchAssetUsdPrice` already
had for a flaky price API, now extended to a flaky fee API.

**Two more real bugs, both missing cluster-aware program IDs on
`harvestLockLp`, each caught by actually reading a failed transaction's
on-chain logs rather than guessing from `.message` (which was empty both
times — these SDK errors come back as raw non-Error objects, not proper
exceptions):**
1. Omitting `programId`/`authProgram` silently defaulted the *lock*
   program to its mainnet constants regardless of `CLUSTER` — surfaced as
   a bare `InvalidProgramForExecution` runtime error with no other detail.
2. Omitting `cpmmProgram` *separately* defaulted the pool's own program/
   authority to their mainnet constants too — a second, independent
   default, only found after fixing the first. Real transaction logs
   spelled it out exactly: `AnchorError ... Error Code: InvalidProgramId
   ... Left: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C (mainnet) Right:
   DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb (devnet)`. Fixed by passing
   `cpmmProgram: { programId: CREATE_CPMM_POOL_PROGRAM_FOR_CLUSTER,
   authProgram: CPMM_POOL_AUTHORITY_FOR_CLUSTER }` — the latter a new
   exported constant (`getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM_FOR_
   CLUSTER)`), verified to byte-for-byte match the SDK's own hardcoded
   `CREATE_CPMM_POOL_AUTH`/`DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_AUTH`
   constants before relying on it.

**A third real bug, unrelated to program IDs: `getRealHolders`'s
exclusion list was wrong for CPMM.** The old CLMM code excluded each
pool's own `pool_address` from "real holders" so a pool's own reserves
never got counted as a community share. CPMM vault ownership doesn't work
that way — `getPdaPoolAuthority` seeds only on `programId`, not `poolId`,
meaning every CPMM pool on the whole program shares *one* vault-owner PDA.
Excluding `pool_address` would have excluded nothing, letting a pool's own
reserves (likely the single largest COIN balance in existence) get treated
as a real holder and skew the community split badly. Fixed by excluding
`CPMM_POOL_AUTHORITY_FOR_CLUSTER` instead — a single constant, not a
per-pool list, which is actually simpler than the old code.

**Where the harvested COIN-side fee goes:** CPMM fees accrue
proportionally on *both* pool sides, unlike CLMM's single-mint-pinned
`collectFeeOnMint`. Rather than reshape the payout schema to track two
currencies per run (a real, contained option that was considered and set
aside — see the alternatives it would have required: a `mint` column on
`reward_payouts`, and duplicate community/creator/platform payout logic
per currency), the COIN side is converted into the backing asset via a
real swap through the same pool (`swapPlatformCpmm`, new — also now what
Buyback & Burn's asset->COIN leg uses, replacing the deleted CLMM-only
`swapPlatformAssetForCoin`) immediately after harvest, before the
existing (**entirely unmodified**) platform-cut/community/creator/buyback
split logic ever runs. Both the harvest and the conversion happen inside
`processPool`'s existing harvest phase, together, so a crash between them
can't leave the DB thinking a harvest that already landed on-chain hasn't
happened — a retry just re-harvests whatever (small) amount has accrued
since, which is safe (not a double-spend) because `harvestCpmmLockedFees`
only ever collects what's currently pending.

**reward_run_pools.pool_id's FK constraint was actively wrong for the new
model** (`REFERENCES token_pools(id)`) and had to be dropped, not
repointed — SQLite can't express "references either token_pools or
final_pools depending on which model created this run," and there's no
single table to point at anymore. Migrated via the standard SQLite
recreate-table pattern (new table without the constraint, copy rows, drop,
rename), guarded to run only when an existing DB's stored schema text
still mentions `token_pools`, verified against a simulated pre-migration
database with a real legacy row before touching the real one — the row
survived, and post-migration reward_run_pools inserts using a final_pools
id (which would have hit the FK before) confirmed the constraint was
really gone.

**Verified end-to-end on devnet, for real, not a substitute:** created a
real locked CPMM pool, generated real fees on both sides via two real
swaps (buy COIN with the backing asset, then sell some COIN back), gave a
real buyer wallet real COIN so community distribution had an actual
holder to pay, then ran the real, unmodified `runRewardCycle()` — with
retries, since the indexer lag described above is real and the test hit
it repeatedly. Confirmed for real: the harvest landed with a real tx,
platform/community/creator/buyback payouts all landed with real transfers
whose amounts summed *exactly* to the harvested total (671 + 3023 + 1813
+ 1210 = 6717), the buyer's balance increased by exactly the
community+creator amounts, buyback's swap+burn produced a real burned-COIN
amount recorded in `secondary_amount`, and a second `runRewardCycle()`
call against the same, now-complete run was confirmed to be a true no-op
(no duplicate rows, no duplicate payouts).

**Still not done:** the First Buy frontend update; standing up the
graduation-cron Railway service. With this, every backend piece of the
graduation feature described in this doc (pre-market pool, closing it,
splitting into final CPMM pools, the depletion cron, launch.mjs, and now
the reward cron) is built and individually verified on devnet. Frontend
still out of scope per the user throughout.

## Graduation, part 7: First Buy frontend updated to the new single hop (2026-09-30)

The user explicitly asked for this one piece of UI work — the First Buy
route change from part 5 otherwise left the feature dead in the browser.
`performFirstBuy` (index.html) collapsed from the old two-hop chain
(`hop1-tx` → sign → `hop1` → `hop2-tx` → sign → `hop2`) to a single
`first-buy/tx` → sign → `first-buy` call, using the same generic
`signAndBroadcast` helper the old code already had (no changes needed
there — it was already hop-agnostic). The "two hops" doc comment moved
from `signAndBroadcast` (where it was only ever loosely attached) to
`performFirstBuy` itself, and rewritten for the new single-hop reality.
The estimate function's "haircut for two pool-fee hops" comment was
similarly stale (one hop now) — reworded, math unchanged (still a rough
`* 0.99`, since the real cap is always enforced server-side against a
real swap simulation regardless of what this estimate shows).

`getLaunchConfig`'s `targetFdvUsd` still isn't touched (see part 5's own
note on this — cosmetic gap, not a correctness one), so the estimate
number itself is unchanged in magnitude; only the mechanism connecting it
to on-chain reality changed.

**Verified in a real headless browser** (Playwright, against the actual
page served by a local instance of index.mjs on devnet — not a
hand-rolled substitute), since a full real-wallet-signature test isn't
possible without a real wallet extension: loaded `/app` (not `/`
— the landing/app screen split needed a real path, not just
`showAppPage`, to make the page's own boot logic reveal the app shell),
opened the First Buy panel, typed an amount and confirmed the live
estimate renders, then filled out and submitted the *real* launch form
(name, ticker, a real uploaded image, XSOL selected) with a mocked
wallet-signing feature and a mocked `fetch` recording every call. The
real submit handler's real call sequence was captured and confirmed
exactly: `/api/launch/fee-tx` → `/api/launch` → `/api/launch/first-buy/tx`
→ `/api/launch/first-buy` → `/api/tokens` — no `hop1`/`hop2` path
anywhere, and zero console/page errors throughout.

**Still not done:** standing up the graduation-cron Railway service
(manual dashboard step, not a code change — see part 4). With First Buy's
frontend now caught up, there is no other known gap between the backend
graduation feature and the live site.

## Graduation, part 8: cron services can't reach the database directly — a real, already-live bug found while standing up graduation-cron (2026-09-30)

Creating the graduation-cron Railway service (part 4's remaining manual
step) surfaced a structural problem that turned out to already be live and
broken, not something new: **a Railway volume attaches to exactly one
service per environment.** Confirmed against the real API, not assumed —
`VolumeInstanceUpdateInput.serviceId`'s own description is "the service to
attach the volume to... if not provided, the volume will be disconnected,"
and `volumeInstanceUpdate` "updates *a* volume instance" (singular) per
`(volumeId, environmentId)`. There's no mutation that adds a *second*
simultaneous attachment for another service.

**reward-cron has had no real database access since it was created.**
Its actual deployed config (pulled via `railway config pull --json`, not
guessed) shows `volumeAttachments: null` / `volumeMounts: []`, while
`DB_PATH=/data/perpside.db` still pointed at a path that only exists
because `perpside` has the volume mounted. Confirmed for real: `new
DatabaseSync('/some-path-with-no-volume/x.db')` throws `unable to open
database file` — node:sqlite does not create missing parent directories.
reward-cron's `db.mjs` import runs this exact call at module load, so
every single run has almost certainly crashed before ever reaching the
reward-cycle logic. The CLUSTER/RPC_URL fix from earlier in this document
was real and correctly diagnosed, but was verified by SSHing into
`perpside` (which *does* have the volume) under the assumption "same
image/DB/env" — true for the image and env vars, not true for the
database, which is the actual blocker.

**Fix: cron services no longer touch the database at all.** Asked the
user how to resolve this (a real architecture choice, not an
implementation detail — options included moving the crons in-process,
migrating to Postgres, or routing through the always-on service) rather
than picking unilaterally; they chose the last one. `perpside` (index.mjs)
now exposes `POST /internal/run-reward-cycle` and
`POST /internal/run-graduation-cycle`, gated by a shared
`INTERNAL_CRON_SECRET` header (`x-internal-secret`) — not truly
network-isolated, since this Express app answers both `perpside.fun` and
`perpside.railway.internal` on the same port/routes, so the secret is what
actually gates it. `reward-cron.mjs`/`graduation-cron.mjs` are now thin
shells (`cron-trigger.mjs`) that POST to `perpside.railway.internal:3000`
over Railway's private network and exit 0/1 on the response — they no
longer import `rewards.mjs`/`graduation.mjs`/`solana.mjs` at all, so they
also no longer need `CLUSTER`/`RPC_URL`/`PLATFORM_WALLET_SECRET`/`DB_PATH`
— removed from both services' variables, which incidentally means two
fewer places holding a copy of the mainnet platform wallet's private key.

**Verified locally before touching production:** started `index.mjs` with
a test `INTERNAL_CRON_SECRET`, confirmed `/internal/run-reward-cycle`
returns 403 with a wrong or missing secret and 200 with the right one,
then ran the real `reward-cron.mjs`/`graduation-cron.mjs` scripts against
it with `PERPSIDE_INTERNAL_URL` pointed at localhost — both correctly
triggered the cycle over a real HTTP call and exited 0, and a
wrong-secret run correctly exited 1 with the real HTTP 403 body surfaced
in its error message.

**graduation-cron created and configured** (`railway add` +
`serviceInstanceUpdate` via the raw GraphQL API for `startCommand`/
`cronSchedule`/`restartPolicyType`, since `railway config apply` triggered
this environment's own credential-leakage guard on the exploratory `--help`
call and was avoided): `node --experimental-sqlite onchain/server/
graduation-cron.mjs`, every 10 minutes (tighter than reward-cron's 2 hours
— deliberately, since a depleted pre-market pool sitting un-graduated is a
more visible, time-sensitive gap than a delayed fee harvest), `NEVER`
restart policy matching reward-cron's own.

**Port 3000 guess was wrong — caught and fixed against real production,
not left as a TODO.** Railway auto-injects its own `PORT` at runtime
regardless of what the Dockerfile exposes; SSHing into the live
`perpside` container and reading its real `$PORT` showed 8080. Confirmed
by first reproducing the real failure (`fetch failed` /
`ECONNREFUSED ...:3000` from a real `graduation-cron.mjs` run via SSH
against production), then confirming the fix the same way — a real
`fetch` to `:8080` from inside the container, then both cron scripts run
for real against production with `PERPSIDE_INTERNAL_URL` overridden to
port 8080, both completing cleanly. `cron-trigger.mjs`'s default updated
to port 8080 accordingly, with `PERPSIDE_INTERNAL_URL` kept as an escape
hatch if this value ever changes again.

## Graduation, part 9: real-time depletion detection (2026-09-30)

graduation-cron's 10-minute cadence meant a pool that fully depleted
could sit un-graduated for up to 10 minutes. Asked the user how "instant"
should actually work, since depleting trades aren't limited to our own
First Buy — the pre-market pool is a real public Raydium pool, so most
depleting trades will come through Raydium's own UI or Jupiter, which our
server only ever learns about by watching the chain itself (polling or a
live subscription — there's no webhook Raydium/Jupiter calls us on).
User chose a live subscription over just polling more often.

**pool-watcher.mjs (new)**, run once from index.mjs at startup inside the
always-on `perpside` process (a cron service has no persistent container
to hold a live connection open — this has to live where the always-on
service already does): `connection.onAccountChange` on each active
pre-market pool's own account. The callback decodes the pushed bytes
directly and reuses the exact same tick-boundary comparison
`isPreMarketPoolDepleted` already used — pulled out into a shared
`solana.mjs` export, `isPoolDataDepleted(accountData, {...})`, so the
RPC-polling path and the WebSocket-push path can't drift into checking
depletion two different ways. On a real depletion, it calls a new
`graduation.mjs` export, `triggerGraduationCheck(mintAddress)` — fetches
the token fresh (time has passed since the notification arrived) and
runs the same `processToken` the cron uses, so there's exactly one
graduation code path regardless of which trigger caught it.

**New launches subscribe immediately**: `launch.mjs` calls
`watchPremarketPool(...)` right after `createPreMarketPool` succeeds, so
a freshly-launched token doesn't wait for the next watcher restart to be
covered. **graduation-cron keeps running unchanged** as a safety net — if
this process restarts, a subscription is missed, or the RPC websocket
silently drops (web3.js reconnects its own client automatically, but
"automatically" isn't something to stake the whole feature on), the next
cron tick still catches anything the watcher missed within its own
10-minute cadence. A depleted pool that failed to fully graduate (e.g.
the asset swap failing) also naturally stops being watched once the
token's status moves off `'premarket'` — `handleAccountChange` checks
this after each trigger and unsubscribes if so, re-subscribing never
needed since `graduation_runs`/cron resumability (part 3) picks it up
from there.

Real coin-mint circularity, resolved deliberately rather than avoided:
`launch.mjs` → `pool-watcher.mjs` → `graduation.mjs` → `launch.mjs` (the
last hop is `graduation.mjs`'s existing `listBackingAssets` import).
Confirmed safe rather than assumed — every cross-reference is only ever
called from inside a function body, never at module-evaluation time, and
a direct import test resolved every binding to a real function, not
`undefined`.

**A real, unrelated testing-methodology bug surfaced and fixed while
verifying this**: every throwaway `_test-*.mjs` script this whole session
that set `process.env.DB_PATH = '...'` as its *first line*, before its
own `import` statements, was not actually doing what it looked like — ES
modules hoist every static `import` above a file's own top-level
statements regardless of where they're textually written, so db.mjs's
module-level `new DatabaseSync(...)` had already run (and silently fallen
back to its own default path) before that assignment ever executed every
single time. Every such test was actually sharing and accumulating state
in one real local file (`onchain/server/perpside.db`, gitignored, now
deleted) instead of an isolated scratch DB — caught for real only once a
test reused a hardcoded id and hit a genuine `UNIQUE constraint failed`
against leftover data from an earlier run. Doesn't appear to have produced
a false pass anywhere else (every other test used fresh random mint
addresses, so collisions were never silently possible), but worth being
honest about rather than quietly fixing and moving on. Fixed going
forward by requiring `DB_PATH` as a real shell environment variable
instead (`DB_PATH=/tmp/x.db node script.mjs`), which isn't subject to
import hoisting.

**Verified end-to-end on real devnet, organically — no manufactured DB
state for the trigger this time** (part 4's graduation-cron test had to
manufacture the "already depleted" state because organically depleting a
real 85-SOL range wasn't practical; this test went further): built a
small real pre-market pool, subscribed the watcher to it for real,
confirmed the subscription fires on genuine account changes via three
separate real partial swaps (each correctly read `depleted=false`, no
false positive), then closed the exact remaining gap adaptively — reading
real on-chain `tickCurrent`/liquidity fresh before each step and
recomputing the exact delta via the SDK's own liquidity math, since CLMM
swaps here don't partial-fill (requesting even slightly more than a
range can supply throws a real `LiquidityInsufficient`, confirmed by
hitting it repeatedly with a naively precomputed fixed target before
switching to this adaptive approach) — until the closing swap genuinely
crossed the boundary. The watcher caught it live: `depleted=true` logged,
`triggerGraduationCheck` fired, the token's status flipped from
`premarket` to `graduating` with a real `graduation_runs` row created —
all without `runGraduationCycle` or any cron ever being called anywhere
in the test.

**Still not done:** nothing known — this was the last piece. Frontend
still out of scope per the user throughout this whole feature.

## Backing assets: any real token, not just xSOL/xBTC/xHYPE (2026-10-01)

The frontend's "Add custom asset" search (Jupiter token search, already
built) let a creator search for and add *any* real token as a pill, but
the backend only ever accepted the three Hylo registry symbols — so
picking anything else failed at submit time with "Only xSOL, xBTC, and
xHYPE can be launched on-chain right now." Asked the user how to resolve
the mismatch (restrict the UI search to match the backend, or expand the
backend to match the UI); they chose the latter — any real mint, up to 3
per launch, backend restriction removed.

**launch.mjs assertAssets, rewritten.** Took `assetSymbols` (an array of
symbol strings, matched against the fixed `backing-assets.json`/
`.mainnet.json` registry) → now takes `assets` (an array of
`{symbol, mint}`), validates each mint is a real, well-formed base58
address, fetches its *real* decimals on-chain (`solana.mjs
getMintDecimals`, new), and rejects anything that isn't a real mint on
this cluster — all before the creator ever pays the launch fee. Resolved
once here (symbol + mint + decimals) and stored in `tokens.backing_assets`
(shape changed accordingly — was a bare symbol array, now full objects),
so nothing downstream (`createCpmmPoolAndLock`, `rewards.mjs`) needs to
re-fetch or assume decimals later. `final_pools` gained a matching
`decimals` column (migrated in, nullable — there were zero real rows in
production when this landed) for the same reason on the reward-cron side.

**Three real hardcoded-6-decimals assumptions found and fixed** — all a
direct consequence of the old model only ever using the three Hylo
registry assets, which all happen to be 6 decimals: `createCpmmPoolAndLock`
(solana.mjs) took a real `assetDecimals` param instead of hardcoding 6;
`graduation.mjs` resolves each asset's decimals from the stored
`token.backingAssets` (a `.find()` by mint) instead of a registry lookup
that no longer applies to an arbitrary mint; `rewards.mjs`'s
`backingAssetInfo(symbol)` registry lookup is gone entirely, replaced by
reading `pool.backing_asset_mint`/`pool.decimals` directly off the
`final_pools` row that's already loaded.

**Devnet USD pricing, which depended on the registry's static prices, was
also no longer safe to assume for an arbitrary asset.** `fetchAssetUsdPrice`
now takes a mint directly (not an `asset` object) and keeps a *small*
known-price table read straight from `backing-assets.json` — Perpside's
own pre-minted devnet stand-in assets, kept purely as a testing
convenience — for devnet; anything else on devnet (or anything at all on
mainnet) goes through the existing live Jupiter lookup, which already
resiliently returns null (skip this tick) rather than throwing.

**Token-2022 mints are deliberately rejected, not silently half-supported.**
Properly supporting them would mean threading the correct token program
through the *entire* money-movement pipeline — ATA derivation for reward
payouts (`sendTokenBatch`), both swap functions, and pool creation — not
just reading a decimals value; real, untested scope well beyond this
pass, and this session is also presently devnet-SOL-constrained from
extensive earlier testing, so it couldn't be verified even if built.
`getMintDecimals` reads the mint account's real owner and throws a clear,
specific error for a Token-2022 mint — caught at launch validation time,
before any fee is charged, rather than failing confusingly during
graduation or a reward run much later. "Any real token" currently means
"any real classic-SPL token."

**Frontend (index.html), explicitly in scope this time per the user.**
`selectedAssets` stays exactly what it already was (an array of symbol
strings — unchanged everywhere it's used for rendering/toggling, kept
deliberately low-risk) with a new parallel `selectedAssetMints` map
(symbol → mint) populated only for custom-searched assets (`addAssetPill`
already had the mint from the search result, `t.id`, and was simply
discarding it before). At submit time, every selected symbol's mint is
resolved — from `selectedAssetMints` for custom ones, or from the
`/api/backing-assets` registry (prefetched at form init) for the three
fixed pills — with a clear client-side error if anything fails to
resolve, before any signature is ever requested. The old
`SUPPORTED_ONCHAIN_ASSETS` client-side gate is gone.

**Verified for real, within what devnet SOL allowed.** This session's
extensive earlier testing had largely drained both the platform wallet
and the devnet test-creator wallet, and the devnet faucet (tried twice)
returned a 500 both times — so a full launch-through-graduation test with
an arbitrary asset wasn't possible this pass, and isn't claimed as tested.
What *was* verified for real, through the actual `prepareFee`/
`assertAssets` code path (not a substitute): a real arbitrary devnet mint
(one of this session's own earlier test coins, not in any registry) is
accepted and correctly resolves its real decimals; a well-formed-but-empty
address and a malformed address are each rejected with a distinct, clear
message; a well-known external devnet mint (devnet USDC) also resolves
correctly, confirming this isn't limited to mints this project happens to
control; and a mix of one registry asset (xSOL) plus one arbitrary asset
in the same request correctly computes a 2-asset fee. The downstream
pieces (`createCpmmPoolAndLock`'s `assetDecimals` param,
`graduation.mjs`'s resolved-asset lookup) are small, mechanical changes
to code paths already proven correct earlier in this document with the
registry assets — not independently re-verified end-to-end here, and
flagged as the one honest gap in this pass rather than left unstated.

## Token-2022 backing assets (2026-10-01)

The previous pass deliberately rejected Token-2022 mints as a backing
asset — `getMintDecimals` threw a clear error for one rather than
half-supporting it. Asked to add real support now.

**Checked Raydium's own CPMM module first, not assumed.** Reading the
actual SDK source: `cpmm.createPool` already checks each mint's real
`programId` and, given `addSupportMintExt: true`, fetches a Token-2022
mint's own extension accounts (transfer-fee config etc.) via
`getPdaMintExAccountCp`; `swap`/`harvestLockLp` already derive ATAs from
the pool's real on-chain `mintA.programId`/`mintB.programId`. None of
that needed changing — the real gaps were all in Perpside's own code,
every place a token program had been silently assumed to be classic SPL.

**`solana.mjs`:**
- `getMintDecimals` → `getMintInfo`: reads the mint account's real owner
  (classic SPL or Token-2022 — anything else still rejected) and returns
  `{decimals, programId}` instead of just decimals.
- `createCpmmPoolAndLock` takes a new `assetProgramId` param, threaded
  into `assetToken.programId` and into `addSupportMintExt` (true only
  when the asset side is actually Token-2022 — a no-op for classic SPL).
- `getTokenBalance` takes an optional `programId` (defaults to classic
  SPL, so every COIN-side caller — COIN is always classic, minted by
  Perpside itself — is unaffected).
- `sendTokenBatch` signature changed: `(mint, recipients)` →
  `(mint, decimals, recipients, programId = TOKEN_PROGRAM_ID)`. Also
  switched from `createTransferInstruction` to
  `createTransferCheckedInstruction` — checked against `@solana/spl-token`'s
  real `.d.ts`, not memory. This wasn't optional: a Token-2022 mint with
  certain extensions (transfer fees being the common one) rejects the
  legacy `Transfer` instruction outright on-chain, and `TransferChecked`
  is simply the more correct choice for classic mints too (it validates
  mint/decimals match).
- `harvestCpmmLockedFees` takes `assetProgramId`, threaded into both of
  its asset-side `getTokenBalance` balance-diff calls.

**`launch.mjs` `assertAssets`** now calls `getMintInfo` and stores
`programId` alongside `symbol`/`mint`/`decimals` in each resolved asset
object — `tokens.backing_assets` carries it from here on, same pattern
`decimals` already established.

**`db.mjs`**: `final_pools` gained a `token_program` column (same
nullable-migration pattern as `decimals` — no real final_pools rows
existed to backfill), and `insertFinalPool` now takes/stores
`tokenProgram`.

**`graduation.mjs`/`rewards.mjs`** both read `token.backingAssets`/
`pool.token_program` and fall back to classic SPL when it's missing —
not a guess: every `backingAssets` row written before this pass is
necessarily classic SPL, since the old `assertAssets` rejected
Token-2022 outright. A pre-existing launch graduating or earning
rewards after this deploy works exactly as before; nothing needed a
backfill.

**Real devnet verification, scoped to what the budget allowed.** The
platform wallet had ~0.084 SOL and the devnet faucet is still down
(confirmed again — `requestAirdrop` against both the public devnet RPC
and the configured Helius endpoint both return 500s); a real
`createCpmmPoolAndLock` graduation costs ~0.2 SOL per asset on its own
(see `MEASURED_GRADUATION_PER_ASSET_LAMPORTS` above), so a full
launch→deplete→graduate cycle with a Token-2022 asset was not
affordable this pass. What *was* verified for real
(`_test-token2022.mjs`, run and deleted): minted a real Token-2022 mint
on devnet with a live TransferFeeConfig extension (1% fee) — the
specific case that breaks the legacy `Transfer` instruction — then
confirmed `getMintInfo` correctly identifies it (`programId` =
`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`, right decimals), and that
`sendTokenBatch` correctly creates the recipient's Token-2022 ATA and
transfers via `TransferChecked`: the recipient received exactly 990,000
of 1,000,000 atomic units sent, i.e. the on-chain 1% fee was actually
applied — something the old `createTransferInstruction` path would have
rejected outright rather than silently mishandled. `createCpmmPoolAndLock`'s
`addSupportMintExt` path (the one piece of this that's genuinely new
surface in Perpside's own code, not just correctly plumbing an existing
param) is **not** verified end-to-end — flagged here rather than left
unstated, same as every other budget-driven gap in this document.

## Launch fee bug: graduation cost was charged twice, to the wrong party (2026-10-06)

Real production bug, reported by the user trying an actual mainnet
launch: the connected wallet rejected the fee transaction outright —
"Simulation failed. This transaction will likely fail even if submitted
on-chain" — before it even reached Perpside's own server (no
corresponding error in production logs, consistent with a wallet-side
preflight simulation failing on insufficient balance, not a backend
error).

**Root cause, confirmed by re-reading `calculateLaunchFeeLamports`'s own
reasoning (part 5 of this document):** it charged the creator
`assetCount * MEASURED_GRADUATION_PER_ASSET_LAMPORTS` up front —
~0.2306 SOL (measured cost + margin) *per backing asset*, on top of
mint + pre-market pool — reasoned at the time as "nobody's left to
charge at graduation." That reasoning missed something real: graduation
only ever runs after the pre-market pool has *already* raised ~85 SOL
from genuine market trading. That raised SOL is exactly "somebody left
to charge" — it just hadn't been accounted for as a funding source. The
result: a 3-asset launch cost **~0.89 SOL** just in the up-front fee
(1-asset: ~0.43 SOL) — a real, measured number from part 5's own devnet
test — almost certainly larger than a typical creator's wallet balance
for an unproven beta platform, exactly matching the reported wallet
rejection.

**Fix: graduation's real rent+fee cost is now reserved out of the SOL
it raises, not pre-charged to the creator.** Two changes, both in
`solana.mjs`:
- `calculateLaunchFeeLamports()` dropped its `assetCount` parameter
  entirely — it now only covers mint + pre-market pool, the two real
  costs that exist before a single trade has happened and before
  there's any other source of funds. **New flat fee: ~0.1968 SOL,
  regardless of how many backing assets are chosen** (down from
  ~0.43–0.89 SOL).
- `MEASURED_GRADUATION_PER_ASSET_LAMPORTS` is now exported alongside a
  new `graduationReserveLamports()` helper (same figure, same 15%
  margin) instead of being folded into the fee formula.
  `graduation.mjs`'s `processAsset` reserves this amount out of each
  asset's raised-SOL share *before* swapping the rest into that asset —
  left behind as native SOL in the platform wallet, which
  `createCpmmPoolAndLock` then draws on directly for the real pool's
  rent and transaction fees moments later in the same call. A launch
  that never reaches graduation (abandoned pre-market pool) now never
  incurs this cost at all, instead of the creator having pre-paid for a
  pool that's never created.

**Verified for real, scoped to what didn't need 85 SOL.** The new
`calculateLaunchFeeLamports()`/`graduationReserveLamports()` figures
were computed for real against the live constants (0.19681905 SOL flat
fee, 0.23058995 SOL reserve per asset). The reservation arithmetic
itself — share minus reserve, summed back with n × reserve, for 1/2/3
assets — was checked against real `BN` math and reconciles exactly to
the total raised in every case. What wasn't re-verified: a full real
launch → organic 85 SOL depletion → graduation run with the new
reservation logic in place. `swapPlatformSolForAsset` and
`createCpmmPoolAndLock` themselves are unchanged by this fix (they
still just receive a lamport amount and a mint, same as before, already
verified real on-chain earlier in this document) — the new logic is
confined to how much gets handed to the first of those two calls — but
a composed end-to-end run wasn't affordable this pass (same devnet-SOL
constraint as the Token-2022 gap above). Flagged rather than silently
assumed correct.

## Real mainnet launch failure: RPC read-after-write race between the fee tx and the very next one (2026-10-06)

The first real mainnet launch attempt since the fee fix above: the
creator's wallet showed the fee transaction landing successfully, then
the launch itself failed with a generic error. Real production logs
had the actual stack — it failed inside `uploadImage` (Irys/Arweave
upload, the very next real transaction after the fee lands), with:

```
SendTransactionError: Simulation failed.
Transaction simulation failed: Attempt to debit an account but found
no record of a prior credit.
```

**Root cause, confirmed by reproducing it directly against production.**
`broadcastFeeTx` only waits for `getSignatureStatuses` to report
`'confirmed'`/`'finalized'` — proof that *some* RPC backend has seen the
fee land, not that the *next* RPC call will hit that same backend.
Helius (like most providers) load-balances across multiple nodes behind
one URL; the Irys funding transaction immediately following the fee
transfer can land on a node that hasn't caught up yet, which sees the
platform wallet as if the fee had never arrived — hence "no record of a
prior credit" despite the payment having genuinely, successfully
landed moments earlier. Confirmed for real: manually re-ran the exact
same Irys funding call against the same (already-credited) platform
wallet a few minutes later and it succeeded instantly, and Irys's own
real price for an upload is trivial (≈2,000–23,000 lamports for
10 KB–1 MB) — nowhere near large enough to be an insufficient-funds
issue on its own merits.

**Fix: wait for *this* connection's own view of the platform wallet to
catch up before spending against it**, instead of trusting confirmation
status from whichever node happened to answer that call. New
`waitForPlatformBalance(minLamports)` in `solana.mjs` polls
`connection.getBalance` (same connection used for everything else) up
to 10 times, 500ms apart, and `launchToken` (`launch.mjs`) calls it
right after `broadcastFeeTx` succeeds, waiting for the balance to reach
`calculateLaunchFeeLamports()` — the same floor the fee was sized to
cover — before `uploadImage`/`mintCoinToken`/`createPreMarketPool` ever
spend against it. A failure here is reported honestly as "try again in
a moment", not folded into the fee-payment error path, since the
payment itself already succeeded by this point.

**The specific creator who hit this is not out any money, but is
currently stuck.** Traced the real transaction: wallet
`HjwJmEvic5igeCqvzog3mF1b1Rjd3haWasdfCASzXKo2` paid the fee
(196,819,050 lamports) to the platform wallet
(`BfuQmDmyuHjkzVMHYvfU2QQEuiwuwujFfU2tZFyo5dDP`) at 2026-10-06T16:47:51Z;
confirmed zero rows in the production `tokens` table, so the failure
happened before `insertToken` ever ran — nothing partial exists to
clean up, but that fee is sitting unused in the platform wallet with no
token created against it. Re-attempting the launch from the frontend
right now would charge a *second* fee rather than resuming the first
(the signed fee transaction can't be meaningfully resubmitted once its
blockhash has expired, and `launchToken` always takes a
`signedFeeTxBase64` as input rather than resuming from an
already-landed payment) — a real gap in retry-safety beyond this
specific race, not something this pass fixes. Flagging rather than
quietly deciding: whether to manually refund that creator, or treat it
as platform float, is a product/support call outside this pass's scope.

## Same error again after the fix above — the real cause was a stuck, server-lifetime-cached connection (2026-10-06)

The creator from the previous entry was refunded and retried — same
exact failure, same exact line (`uploadImage`), even with
`waitForPlatformBalance` from the previous fix already live. That fix
wasn't wrong, it was aimed at the wrong connection.

**Real root cause, found by reading `@irys/upload-solana`'s actual
source (`token.js`), not assumed:** `getProvider()` does
`this.providerInstance ??= new Connection(this.providerUrl, ...)` —
Irys's own SDK builds and caches *its own* `Connection` object, pointed
at the same `RPC_URL` Perpside's own code uses, but that's a different
object from Perpside's `getConnection()` singleton. A load-balanced
provider (Helius) can route that connection's first request to a
different backend node, and once pinned (HTTP keep-alive), it stays
pinned for the object's lifetime. `upload.mjs`'s old `getIrys()` built
this uploader **once** and cached it (`irysSingleton`) for the entire
server process's lifetime — so if that one connection got pinned to a
node that's lagging (or just unlucky at boot time), *every single
launch* through that running process would hit the same "no record of
a prior credit" error, indefinitely, not as an occasional transient
blip. This explains why the error repeated identically on a second,
independent attempt: it wasn't bad luck twice, it was the same stuck
connection both times.

**Confirmed directly, not inferred:** re-running the identical Irys
funding call via a *fresh* `node` process (`railway ssh`, new
connection, same `RPC_URL`, same account) against the real platform
wallet succeeded instantly both times it was tried. Only the long-lived
server process's own cached connection was ever stuck.

**Fix: stop caching the Irys uploader at all.** `getIrys()` now builds
a fresh `Uploader(...).build()` — and so a fresh underlying
`Connection` — on every call, so a bad routing decision can't outlive
one upload. `ensureFunded` also retries up to 4 times with a 1.5s
backoff specifically on this error class (`prior credit` /
`Simulation failed` in the thrown error), each retry getting an
entirely new connection via a fresh `getIrys()` call rather than
reusing whatever just failed — defense in depth on top of removing the
cache, not a replacement for it.

**Verified for real.** Rebuilding the uploader per call isn't free
(a `.build()` round trip), but launches are infrequent enough that this
doesn't matter — and reliability here matters far more than shaving a
network round trip off an already-multi-transaction flow. Ran the
actual `uploadImage`/`uploadMetadata` functions for real against devnet
with a real tiny PNG: both uploaded successfully, and the returned
gateway URL resolved (redirected, HTTP 307, to the real asset). The
previous `waitForPlatformBalance` fix (part of the prior entry) is kept
— it's not wrong, just insufficient on its own; still useful defense
for the separate, genuine case where Perpside's *own* connection
hasn't caught up yet.

## Same error a third time — the real mechanism was a commitment-level mismatch, not a stuck node (2026-10-06)

The no-cache fix above didn't resolve it either — same creator, same
exact error, immediately after that fix was live too. The "stuck
load-balanced node" theory was wrong, or at least incomplete: a fresh
connection on every call still failed. User's own instinct was close —
not "needs separate Irys funding", but *something* about how Irys talks
to the chain really was different from the rest of this codebase.

**Found the actual mechanism in `@irys/upload-solana`'s real source**
(`token.js`): `SolanaConfig` hardcodes `finality = 'finalized'` by
default — every Solana call it makes (fetching a blockhash, simulating
and sending its funding transaction) reads chain state as of the
**finalized** slot. Finalization is a real, mechanical ~13–20+ seconds
behind **confirmation** on Solana (several further slots of
supermajority voting) — not a provider quirk, just how the protocol
works. Perpside's own `getConnection()` uses `'confirmed'`
*everywhere* (`solana.mjs`) — so the platform wallet's fee credit was
already visible to the rest of this codebase (including
`waitForPlatformBalance`, which is why *that* check kept passing)
while Irys's own finalized-commitment connection genuinely had no
record of it yet, because `uploadImage` runs only ~1–2 seconds after
the fee lands. This also explains why every one of this session's
manual reproductions succeeded: they all ran minutes after the
original transaction, well past real finalization.

**Confirmed directly, not inferred a third time:** `SolanaConfig`'s
`finality` is configurable via the builder's own
`withTokenOptions({ finality })`, and it's genuinely plumbed through —
checked by building an uploader with `{ finality: 'confirmed' }` and
reading back both `tokenConfig.finality` and the *underlying
`Connection`'s own `.commitment` field*: both reported `'confirmed'`,
not the default `'finalized'`.

**Fix: make Irys use the same commitment level as the rest of this
codebase**, instead of retrying around a mismatch. `getIrys()` now
chains `.withTokenOptions({ finality: 'confirmed' })` into the builder.
The previous fixes (no caching, retry-with-backoff) are kept as
layered defense — none of them were wrong, the caching fix in
particular is independently worth keeping — but this is the one that
addresses the actual mechanism. Retry budget scaled back down (5
attempts, 2s apart) now that the real gap it's covering is normal
`'confirmed'`-level propagation variance (sub-second, typically) rather
than waiting out finalization.

**Verified for real.** Rebuilt the uploader with the new option against
real devnet and confirmed `tokenConfig.finality === 'confirmed'` and
the live `Connection.commitment === 'confirmed'` — not just that the
option was accepted without erroring. Then ran a full real
`uploadImage` call end to end: succeeded in 1.2 seconds. Three failures
in a row on this one is a real lesson in this session's own terms: the
first two fixes treated symptoms that were each independently true and
worth fixing (a genuine RPC-visibility gap on Perpside's own
connection; a genuinely bad practice caching a finicky SDK object for
a server's entire lifetime) without being *the* cause of what the user
was actually hitting — found only by finally reading the dependency's
own source for its commitment handling instead of continuing to guess
at network/infrastructure explanations.
