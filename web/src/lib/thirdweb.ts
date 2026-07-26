// SPDX-License-Identifier: MIT
//
// Thirdweb client for the wallet sign-in fallback shown in the header when the browser has no
// injected wallet (MetaMask, etc.) to fall back to. Additive only: this file is not imported by
// the demo/preview signer path in lib/doca.ts, which stays untouched.
import { createThirdwebClient, type ThirdwebClient } from "thirdweb";
import { inAppWallet, createWallet, type Wallet } from "thirdweb/wallets";

// Client ID only (browser-safe, never the secret key). Set in the repo root .env as
// VITE_THIRDWEB_CLIENT_ID; documented default lives in .env.example. Vite's envDir for this
// project is the repo root (see web/plugins/lp-desk-dev.ts), so that's where the .env lives.
const clientId = import.meta.env.VITE_THIRDWEB_CLIENT_ID as string | undefined;

if (!clientId && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn("[thirdweb] VITE_THIRDWEB_CLIENT_ID is not set; wallet sign-in fallback stays hidden.");
}

// undefined when unconfigured so the header can fall back to the original "Preview wallet" pill
// instead of throwing (createThirdwebClient requires a non-empty clientId or secretKey).
export const thirdwebClient: ThirdwebClient | undefined = clientId
    ? createThirdwebClient({ clientId })
    : undefined;

// In-app wallet (email / Google / passkey / phone OTP) plus WalletConnect for QR-based sign-in
// from a mobile wallet. No injected-wallet entries here; that path already has its own button.
export const thirdwebWallets: Wallet[] = [
    inAppWallet({
        // "guest" gives a one-click ephemeral account: the fastest way to try the desk
        // without a wallet or an inbox, and what the demo path upgrades from.
        auth: { options: ["email", "google", "passkey", "phone", "guest"] },
    }),
    createWallet("walletConnect"),
];
