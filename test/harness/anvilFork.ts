import { spawn, type ChildProcess } from "node:child_process";
import { createTestClient, http, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";

export type ForkClient = ReturnType<typeof createTestClient> &
  ReturnType<typeof publicActions> &
  ReturnType<typeof walletActions>;

export interface AnvilFork {
  rpcUrl: string;
  client: ForkClient;
  stop: () => void;
  snapshot: () => Promise<`0x${string}`>;
  revert: (id: `0x${string}`) => Promise<void>;
  impersonate: (address: `0x${string}`) => Promise<void>;
  stopImpersonating: (address: `0x${string}`) => Promise<void>;
}

// Spawn a local anvil fork of `forkUrl` and wire a viem test client with
// snapshot/revert/impersonate actions. Strategies run against this pinned,
// disposable state: no real funds, no live chain writes.
export async function startAnvilFork(forkUrl: string, port = 8545): Promise<AnvilFork> {
  const proc = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--silent"]);
  const rpcUrl = `http://127.0.0.1:${port}`;

  await waitForRpc(rpcUrl, proc);

  const client = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) })
    .extend(publicActions)
    .extend(walletActions);

  return {
    rpcUrl,
    client,
    stop: () => proc.kill(),
    snapshot: () => client.snapshot(),
    revert: (id) => client.revert({ id }),
    impersonate: (address) => client.impersonateAccount({ address }),
    stopImpersonating: (address) => client.stopImpersonatingAccount({ address }),
  };
}

// Poll the RPC until anvil responds or the process exits early.
async function waitForRpc(url: string, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`anvil exited early (code ${proc.exitCode}): is foundry installed and on PATH?`);
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet, keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`anvil did not respond on ${url} within ${timeoutMs}ms`);
}
