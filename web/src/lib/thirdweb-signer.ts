// SPDX-License-Identifier: MIT
//
// Bridges a thirdweb in-app account (email / passkey / guest) into the app's ethers signer
// path. The enclave signs; the practice fork transports. Every transaction is populated and
// broadcast through the fork provider, so a signed-in account can never reach the real network
// from here, exactly like the injected-wallet path.
import { ethers } from "ethers";
import type { Account } from "thirdweb/wallets";

export class ThirdwebSigner extends ethers.AbstractSigner {
    readonly address: string;
    readonly #account: Account;

    constructor(account: Account, provider: ethers.Provider) {
        super(provider);
        this.#account = account;
        this.address = account.address;
    }

    async getAddress(): Promise<string> {
        return this.address;
    }

    connect(provider: ethers.Provider | null): ThirdwebSigner {
        if (!provider) throw new Error("ThirdwebSigner needs a provider");
        return new ThirdwebSigner(this.#account, provider);
    }

    async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
        const sign = this.#account.signTransaction;
        if (!sign) throw new Error("this account cannot sign raw transactions");
        // Populated by sendTransaction below; populate again defensively for direct callers.
        const pop = tx.nonce != null && tx.gasLimit != null && tx.chainId != null
            ? tx
            : await this.populateTransaction(tx);
        return await sign({
            type: "eip1559",
            chainId: Number(pop.chainId),
            nonce: Number(pop.nonce),
            to: (pop.to ?? undefined) as `0x${string}` | undefined,
            data: (pop.data ?? "0x") as `0x${string}`,
            value: pop.value != null ? BigInt(pop.value.toString()) : undefined,
            gas: BigInt(pop.gasLimit!.toString()),
            maxFeePerGas: pop.maxFeePerGas != null ? BigInt(pop.maxFeePerGas.toString()) : undefined,
            maxPriorityFeePerGas: pop.maxPriorityFeePerGas != null ? BigInt(pop.maxPriorityFeePerGas.toString()) : undefined,
        });
    }

    async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
        const pop = await this.populateTransaction(tx);
        delete (pop as { from?: unknown }).from;
        const raw = await this.signTransaction(pop);
        return await this.provider!.broadcastTransaction(raw);
    }

    async signMessage(message: string | Uint8Array): Promise<string> {
        return await this.#account.signMessage({
            message: typeof message === "string" ? message : { raw: ethers.hexlify(message) as `0x${string}` },
        });
    }

    async signTypedData(
        domain: ethers.TypedDataDomain,
        types: Record<string, ethers.TypedDataField[]>,
        value: Record<string, unknown>,
    ): Promise<string> {
        const primaryType = ethers.TypedDataEncoder.getPrimaryType(types);
        return await this.#account.signTypedData({
            domain, types, primaryType, message: value,
        } as Parameters<Account["signTypedData"]>[0]);
    }
}
