# Dev setup

Branches: `main` is demo-stable (the video records from it); `dev` is the integration branch —
work here or in feature branches and PR into `main` only when it builds.

## Full stack, from zero

```bash
# 1. chain: anvil forking Base at the pinned block (canonical Aqua + real WETH/USDC live there)
anvil --fork-url https://mainnet.base.org --fork-block-number 49093600 --chain-id 8453 --host 0.0.0.0

# 2. contracts: install, test, deploy our side + seed the demo wallet
cd contracts && yarn && npx hardhat test
npx hardhat run scripts/deploy-for-web.ts --network localhost   # writes web/src/deployment.json

# 3. app (vite dev server on :5273)
cd ../web && bun install && bun run dev

# 4. static pages (deck, landing, dossier) — optional
bunx serve -l tcp://0.0.0.0:4180 .   # from repo root
```

Reset demo state at any time by re-running step 2's deploy script (it `anvil_reset`s the fork).

## Where things live

- `web/src/lib/plimsoll.ts` — every chain call the UI uses (read/ship/dock/fill, wallet connect).
  Build new views against these exports; `App.tsx` is the consumer journey and stays stable.
- `contracts/contracts/` — `InventorySkewProvider.sol` + `PlimsollApp.sol`; tests in `contracts/test/`.
- `deck/` pitch slides · `landing/` landing page · `docs/dossier.html` design dossier · `media/` submission assets.

## Gotchas

- GitHub rejects pushes with a private email: `git config user.email "<id>+<user>@users.noreply.github.com"`.
- The fork inherits real Base nonces — the app handles it with NonceManager; scripts should too.
- `main` must always `bun run build` green.
