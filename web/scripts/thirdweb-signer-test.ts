// Verifies the ThirdwebSigner bridge against a live fork: populate -> viem-shape serialize ->
// sign -> broadcast. The mock account implements the same signTransaction contract the thirdweb
// enclave exposes, backed by a local key, so the field mapping is what's under test.
// Run: bun scripts/thirdweb-signer-test.ts <fork-rpc-url>
import { ethers } from "ethers";
import { ThirdwebSigner } from "../src/lib/thirdweb-signer";

const rpc = process.argv[2] ?? "http://127.0.0.1:8547";
const provider = new ethers.JsonRpcProvider(rpc, 8453, { staticNetwork: true });
const key = ethers.Wallet.createRandom();
const raw = new ethers.Wallet(key.privateKey);

const mockAccount = {
    address: key.address as `0x${string}`,
    async signTransaction(tx: Record<string, unknown>): Promise<`0x${string}`> {
        // Same shape thirdweb's enclave receives; map viem serializable -> ethers request.
        return await raw.signTransaction({
            type: 2,
            chainId: tx.chainId as number,
            nonce: tx.nonce as number,
            to: tx.to as string,
            data: (tx.data as string) ?? "0x",
            value: (tx.value as bigint) ?? 0n,
            gasLimit: tx.gas as bigint,
            maxFeePerGas: tx.maxFeePerGas as bigint,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas as bigint,
        }) as `0x${string}`;
    },
    async signMessage({ message }: { message: string | { raw: `0x${string}` } }) {
        return await raw.signMessage(typeof message === "string" ? message : ethers.getBytes(message.raw)) as `0x${string}`;
    },
    async signTypedData() { throw new Error("unused"); },
    async sendTransaction() { throw new Error("unused: ThirdwebSigner broadcasts itself"); },
};

const WETH = "0x4200000000000000000000000000000000000006";

const main = async () => {
    await provider.send("anvil_setBalance", [key.address, "0x8AC7230489E80000"]); // 10 ETH
    const signer = new ThirdwebSigner(mockAccount as never, provider);

    const weth = new ethers.Contract(WETH, ["function deposit() payable", "function balanceOf(address) view returns (uint256)"], signer);
    const tx = await (weth as any).deposit({ value: ethers.parseEther("0.1") });
    const rcpt = await tx.wait();
    const bal = await (weth as any).balanceOf(key.address);
    const sig = await signer.signMessage("doca");
    const recovered = ethers.verifyMessage("doca", sig);

    console.log(JSON.stringify({
        from: rcpt.from,
        expected: key.address,
        fromOk: rcpt.from === key.address,
        status: rcpt.status,
        wethBalance: ethers.formatEther(bal),
        messageSigOk: recovered === key.address,
    }));
};

main().then(() => process.exit(0)).catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
