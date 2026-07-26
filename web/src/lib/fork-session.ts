// SPDX-License-Identifier: MIT
//
// Shared Base-fork session for Harbor + LP Desk.
// Maker is either the anvil demo key or an injected wallet (EIP-1193).
// Taker stays on the demo key: it plays the market, not the user.
// All writes still hit the local fork when MetaMask is pointed at it.
import { ethers } from "ethers";
import deployment from "../deployment.json";

const KEYS = {
    maker: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    taker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
    "function deposit() payable",
];

const rpcUrl = import.meta.env.VITE_RPC_URL
    || (typeof window !== "undefined" ? `http://${window.location.hostname}:8545` : deployment.rpcUrl);

export const provider = new ethers.JsonRpcProvider(rpcUrl, deployment.chainId, {
    staticNetwork: true,
});

export const makerSigner = new ethers.NonceManager(new ethers.Wallet(KEYS.maker, provider));
export const takerSigner = new ethers.NonceManager(new ethers.Wallet(KEYS.taker, provider));

export type Session = { mode: "demo" | "wallet"; maker: string };
export const session: Session = { mode: "demo", maker: deployment.maker };

let maker: ethers.Signer = makerSigner;
type MakerListener = (signer: ethers.Signer, session: Session) => void;
const listeners = new Set<MakerListener>();

export function getMaker(): ethers.Signer {
    return maker;
}

export function onMakerChange(cb: MakerListener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function notify() {
    for (const cb of listeners) cb(maker, session);
}

export function hasInjectedWallet(): boolean {
    return typeof window !== "undefined" && !!(window as any).ethereum;
}

export async function connectWallet(): Promise<string> {
    const injected = (window as any).ethereum;
    if (!injected) throw new Error("no injected wallet");
    const browser = new ethers.BrowserProvider(injected);
    const signer = await browser.getSigner();
    const addr = await signer.getAddress();
    const net = await browser.getNetwork();
    if (Number(net.chainId) !== Number(deployment.chainId)) {
        try {
            await injected.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: "0x" + Number(deployment.chainId).toString(16) }],
            });
        } catch {
            throw new Error(`wallet is on chain ${net.chainId}; switch it to the practice network (chain ${deployment.chainId}) to act as maker`);
        }
    }
    // The practice fork shares Base's chain id, so a chain-id match alone can still be the
    // real network. Before letting the wallet sign anything, prove the injected provider sees
    // the fork's own chain state: the fork's latest block hash exists nowhere else.
    const forkTip = await provider.getBlock("latest");
    const seen = await new ethers.BrowserProvider(injected).getBlock(forkTip!.number).catch(() => null);
    if (!seen || seen.hash !== forkTip!.hash) {
        throw new Error("this wallet is connected to the real network, not the practice fork; wallet mode stays disabled to keep real funds out of the demo");
    }
    maker = signer;
    session.mode = "wallet";
    session.maker = addr;
    notify();
    return addr;
}

export async function seedConnectedWallet(): Promise<void> {
    const client: string = await provider.send("web3_clientVersion", []);
    if (!client.toLowerCase().includes("anvil")) throw new Error("seeding only works on the anvil fork");
    const addr = session.maker;
    const weth = new ethers.Contract(deployment.weth, ERC20_ABI, maker);
    const usdc = new ethers.Contract(deployment.usdc, ERC20_ABI, maker);
    await provider.send("anvil_setBalance", [addr, "0x21E19E0C9BAB2400000"]); // 10,000 ETH of gas money
    const usdcSlot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, 9n]));
    await provider.send("anvil_setStorageAt", [deployment.usdc, usdcSlot, ethers.toBeHex(8_000_000_000n, 32)]);
    await (await (weth as any).deposit({ value: ethers.parseEther("2") })).wait();
    await (await weth.approve(deployment.aqua, ethers.MaxUint256)).wait();
    await (await usdc.approve(deployment.aqua, ethers.MaxUint256)).wait();
}
