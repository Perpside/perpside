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
