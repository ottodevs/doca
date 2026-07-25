// SPDX-License-Identifier: MIT
//
// Canonical Base deployments. Verified live on 2026-07-25 against https://mainnet.base.org:
// Aqua has 6251 bytes of code, and SwapVM has 22640 and carries the Aqua address as an immutable,
// which is what identifies it as the Aqua-backed router rather than the signature-only one.
export const BASE = {
    aqua: "0x499943e74fb0ce105688beee8ef2abec5d936d31",
    swapVM: "0x8fdd04dbf6111437b44bbca99c28882434e0958f",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
