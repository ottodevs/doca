// SPDX-License-Identifier: MIT
//
// Stages the demo on a fork of Base, against 1inch's own live contracts.
//
// Nothing here is a mock: Aqua, SwapVM, WETH and USDC are the real deployed contracts at their real
// Base addresses. Only two contracts of ours get deployed, and the maker's balances are seeded on the
// fork so the same flow can later be pointed at real Base by changing one env var.
//
//   FORK_BASE=1 npx hardhat run scripts/bootstrap-base-fork.ts
//
import { deployContract } from "@1inch/solidity-utils";
import { BASE } from "./base-addresses";

const { ethers, network } = require("hardhat");



const WETH_ABI = [
    "function deposit() payable",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function decimals() view returns (uint8)",
];

// Circle's FiatToken keeps balances in a mapping at storage slot 9.
const USDC_BALANCES_SLOT = 9n;

async function seedUsdc(holder: string, amount: bigint) {
    const slot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, USDC_BALANCES_SLOT]),
    );
    await network.provider.send("hardhat_setStorageAt", [
        BASE.usdc,
        slot,
        ethers.toBeHex(amount, 32),
    ]);
}

async function main() {
    const [deployer, maker, taker] = await ethers.getSigners();
    const makerAddr = await maker.getAddress();

    const code = await ethers.provider.getCode(BASE.aqua);
    if (code === "0x") throw new Error("no Aqua at the canonical address: is FORK_BASE=1 set?");
    console.log(`Fork of Base at block ${await ethers.provider.getBlockNumber()}`);
    console.log(`  Aqua   ${BASE.aqua}  (${(code.length - 2) / 2} bytes, live)`);

    // Our side: two small contracts. Everything else is 1inch's.
    const app: any = await deployContract("PlimsollApp", [BASE.aqua]);
    const skew: any = await deployContract("InventorySkewProvider", [BASE.aqua, BASE.swapVM]);
    console.log(`  PlimsollApp           ${await app.getAddress()}`);
    console.log(`  InventorySkewProvider ${await skew.getAddress()}`);

    // Seed the maker with real tokens: WETH by wrapping ETH, USDC by writing the balance slot.
    const weth = new ethers.Contract(BASE.weth, WETH_ABI, maker);
    const usdc = new ethers.Contract(BASE.usdc, ERC20_ABI, maker);

    await network.provider.send("hardhat_setBalance", [makerAddr, ethers.toBeHex(ethers.parseEther("20"))]);
    await weth.deposit({ value: ethers.parseEther("2") });
    await seedUsdc(makerAddr, 8_000_000_000n); // 8,000 USDC, 6 decimals

    const wethBal: bigint = await weth.balanceOf(makerAddr);
    const usdcBal: bigint = await usdc.balanceOf(makerAddr);
    console.log("");
    console.log(`Maker ${makerAddr}`);
    console.log(`  WETH ${ethers.formatEther(wethBal)}`);
    console.log(`  USDC ${ethers.formatUnits(usdcBal, 6)}`);
    if (wethBal === 0n || usdcBal === 0n) throw new Error("seeding failed");

    // Bounded approvals, not MaxUint256: the same habit we want when this runs on real Base.
    await weth.approve(BASE.aqua, wethBal);
    await usdc.approve(BASE.aqua, usdcBal);

    // A snapshot of exactly this state, so the demo can be replayed from a clean slate.
    const snapshot = await network.provider.send("evm_snapshot", []);
    console.log("");
    console.log(`Snapshot ${snapshot} taken. Restore with evm_revert to replay the demo.`);
    console.log("");
    console.log(JSON.stringify({
        chainId: 8453,
        aqua: BASE.aqua,
        swapVM: BASE.swapVM,
        weth: BASE.weth,
        usdc: BASE.usdc,
        plimsollApp: await app.getAddress(),
        skewProvider: await skew.getAddress(),
        maker: makerAddr,
        taker: await taker.getAddress(),
        snapshot,
    }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
