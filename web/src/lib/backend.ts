// SPDX-License-Identifier: MIT
//
// Mode switch between the live chain backend (lib/doca.ts) and the scripted guided-replay
// backend (lib/replay.ts). App.tsx imports the action functions from here instead of doca.ts
// directly, so the chain path stays byte-identical when replay is off (mode defaults to
// "chain" and every export below just forwards to doca.ts until setBackendMode("replay") runs).
import * as chain from "./doca";
import * as replay from "./replay";
import type { Order, Preset, Strategy, Wallet } from "./doca";

export type { Preset, Strategy, Wallet, Order };

export type BackendMode = "chain" | "replay";

let mode: BackendMode = "chain";

export function backendMode(): BackendMode {
    return mode;
}

export function setBackendMode(next: BackendMode): void {
    mode = next;
    if (next === "replay") replay.resetReplay();
}

export const readWallet = (): Promise<Wallet> =>
    mode === "replay" ? replay.readWallet() : chain.readWallet();

export const readStrategy = (s: Parameters<typeof chain.readStrategy>[0]): Promise<Strategy> =>
    mode === "replay" ? replay.readStrategy(s) : chain.readStrategy(s);

export const start = (preset: Preset, wallet: Wallet): Promise<Strategy[]> =>
    mode === "replay" ? replay.start(preset, wallet) : chain.start(preset, wallet);

export const shipStrategy = (
    salt: bigint, promisedWeth: bigint, promisedUsdc: bigint, budgetWeth: bigint, budgetUsdc: bigint,
): Promise<Strategy> =>
    mode === "replay"
        ? replay.shipStrategy(salt, promisedWeth, promisedUsdc, budgetWeth, budgetUsdc)
        : chain.shipStrategy(salt, promisedWeth, promisedUsdc, budgetWeth, budgetUsdc);

export const dock = (s: Strategy): Promise<void> =>
    mode === "replay" ? replay.dock(s) : chain.dock(s);

export const marketFill = (s: Strategy, usdcAmount: bigint): Promise<{ ok: boolean; reason?: string }> =>
    mode === "replay" ? replay.marketFill(s, usdcAmount) : chain.marketFill(s, usdcAmount);

export const spendWeth = (amount: bigint): Promise<void> =>
    mode === "replay" ? replay.spendWeth(amount) : chain.spendWeth(amount);

export const resetNonces = (): void =>
    mode === "replay" ? replay.resetNonces() : chain.resetNonces();
