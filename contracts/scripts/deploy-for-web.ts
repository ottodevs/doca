// SPDX-License-Identifier: MIT
//
// Resets the Base fork to a clean pinned state, deploys our side of the stack, seeds the maker's
// wallet with real WETH and USDC, and writes the addresses where the web app can read them.
//
//   npx hardhat run scripts/deploy-for-web.ts --network localhost
//
import { deployContract } from "@1inch/solidity-utils";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { BASE } from "./base-addresses";

const { ethers, network } = require("hardhat");

const FORK_BLOCK = 49_093_600;
const WETH_SEED = ethers.parseEther("2");
const USDC_SEED = 8_000_000_000n;      // 8,000 USDC
const TAKER_USDC = 200_000_000_000n;   // 200,000 USDC so the taker never runs dry in a demo

const WETH_ABI = [
    "function deposit() payable",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
];

const usdcSlot = (holder: string) =>
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, 9n]));

async function main() {
    await network.provider.send("anvil_reset", [{
        forking: {
            jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
            blockNumber: FORK_BLOCK,
        },
    }]);

    const [deployer, maker, taker] = await ethers.getSigners();
    const makerAddr = await maker.getAddress();
    const takerAddr = await taker.getAddress();

    if ((await ethers.provider.getCode(BASE.aqua)) === "0x") {
        throw new Error("no Aqua at the canonical address: is the anvil fork of Base running?");
    }

    // Official router code, unmodified, wired to the canonical live Aqua registry.
    const router: any = await deployContract("AquaSwapVMRouter", [
        BASE.aqua, BASE.weth, await deployer.getAddress(), "AquaSwapVM", "1.0.0",
    ]);
    const app: any = await deployContract("PlimsollApp", [BASE.aqua]);
    const aquaAmm: any = await deployContract("AquaAMM", [BASE.aqua]);
    const skew: any = await deployContract("InventorySkewProvider", [BASE.aqua, await router.getAddress()]);

    // Seed real tokens on the fork: WETH by wrapping, USDC by writing the balance slot.
    const weth = new ethers.Contract(BASE.weth, WETH_ABI, maker);
    const usdc = new ethers.Contract(BASE.usdc, ERC20_ABI, maker);
    await weth.deposit({ value: WETH_SEED });
    await network.provider.send("anvil_setStorageAt", [BASE.usdc, usdcSlot(makerAddr), ethers.toBeHex(USDC_SEED, 32)]);
    await network.provider.send("anvil_setStorageAt", [BASE.usdc, usdcSlot(takerAddr), ethers.toBeHex(TAKER_USDC, 32)]);

    // Bounded approvals to Aqua, and the taker approves the router to take its side of a fill.
    await weth.approve(BASE.aqua, WETH_SEED);
    await usdc.approve(BASE.aqua, USDC_SEED);
    await usdc.connect(taker).approve(await router.getAddress(), TAKER_USDC);

    const deployment = {
        chainId: 8453,
        forkBlock: FORK_BLOCK,
        rpcUrl: "http://127.0.0.1:8545",
        aqua: BASE.aqua,
        router: await router.getAddress(),
        plimsollApp: await app.getAddress(),
        aquaAmm: await aquaAmm.getAddress(),
        skewProvider: await skew.getAddress(),
        weth: BASE.weth,
        usdc: BASE.usdc,
        maker: makerAddr,
        taker: takerAddr,
    };

    const out = join(__dirname, "..", "..", "web", "src");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n");

    const snapshot = await network.provider.send("evm_snapshot", []);
    console.log(JSON.stringify({ ...deployment, snapshot }, null, 2));
    console.log(`\nwrote web/src/deployment.json, snapshot ${snapshot}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
