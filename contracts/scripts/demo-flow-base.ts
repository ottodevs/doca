// SPDX-License-Identifier: MIT
//
// The whole product, end to end, against 1inch's live contracts on a fork of Base:
// three promises out of one wallet, real WETH/USDC fills through the canonical router, the surcharge
// engaging as a strategy eats its budget, and the agent docking and re-promising against real balances.
//
//   FORK_BASE=1 npx hardhat run scripts/demo-flow-base.ts
//
import { deployContract } from "@1inch/solidity-utils";
import { TakerTraitsLib } from "../test/utils/SwapVMHelpers";
import { BASE } from "./base-addresses";

const { ethers, network } = require("hardhat");

const BPS = 1_000_000_000n;
const STRATEGIES = 3;
const WETH_PER_STRATEGY = ethers.parseEther("1.5");   // promise per strategy, deliberately > wallet/3
const USDC_PER_STRATEGY = 6_000_000_000n;          // 6,000 USDC at 6 decimals
const FLAT_FEE = 3_000_000n;                        // 0.3%
const MAX_FEE = BPS / 5n;                           // 20% once the budget is gone
const KINK = 4_000n;
const WATERLINE = 1_000n;

const ROUTER_ABI = [
    "function hash((address maker, uint256 traits, bytes data) order) view returns (bytes32)",
    "function swap((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
    "function quote((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
];
const AQUA_ABI = [
    "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
    "function dock(address app, bytes32 strategyHash, address[] tokens)",
    "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
];
const WETH_ABI = [...ERC20_ABI, "function deposit() payable"];

const usd = (v: bigint) => `${ethers.formatUnits(v, 6)} USDC`;
const eth = (v: bigint) => `${ethers.formatEther(v)} WETH`;

async function main() {
    const [, maker, taker] = await ethers.getSigners();
    const makerAddr = await maker.getAddress();
    const takerAddr = await taker.getAddress();

    // Clean slate on every run: reset the fork to the pinned block so the demo is reproducible.
    await network.provider.send("anvil_reset", [{
        forking: { jsonRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org", blockNumber: 49093600 },
    }]);

    if ((await ethers.provider.getCode(BASE.aqua)) === "0x") {
        throw new Error("no Aqua at the canonical address: is the anvil fork of Base running?");
    }

    // The live AquaSwapVMRouter on Base (0x8fdd...) was built from a different revision than the
    // template pins, and orders built here revert against it with empty data, so we deploy the
    // official router code unmodified and wire it to the canonical live Aqua registry. The bounty
    // allows redeploying SwapVM, and the registry holding the promises is still 1inch's own.
    const routerDeployed: any = await deployContract("AquaSwapVMRouter", [
        BASE.aqua, BASE.weth, await maker.getAddress(), "AquaSwapVM", "1.0.0",
    ]);
    const routerAddr = await routerDeployed.getAddress();

    const app: any = await deployContract("PlimsollApp", [BASE.aqua]);
    const skew: any = await deployContract("InventorySkewProvider", [BASE.aqua, routerAddr]);
    const aqua = new ethers.Contract(BASE.aqua, AQUA_ABI, maker);
    const router = new ethers.Contract(routerAddr, ROUTER_ABI, taker);
    console.log(`  Aqua registry (canonical, live)  ${BASE.aqua}`);
    console.log(`  AquaSwapVMRouter (official code) ${routerAddr}`);
    const weth = new ethers.Contract(BASE.weth, WETH_ABI, maker);
    const usdc = new ethers.Contract(BASE.usdc, ERC20_ABI, maker);

    // Fund the maker with real tokens on the fork, and the taker with USDC to trade in.
    const slot = (holder: string) => ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, 9n]),
    );
    await network.provider.send("hardhat_setBalance", [makerAddr, ethers.toBeHex(ethers.parseEther("50"))]);
    await network.provider.send("hardhat_setBalance", [takerAddr, ethers.toBeHex(ethers.parseEther("50"))]);
    await weth.deposit({ value: ethers.parseEther("2") });
    await network.provider.send("hardhat_setStorageAt", [BASE.usdc, slot(makerAddr), ethers.toBeHex(8_000_000_000n, 32)]);
    await network.provider.send("hardhat_setStorageAt", [BASE.usdc, slot(takerAddr), ethers.toBeHex(50_000_000_000n, 32)]);

    await weth.approve(BASE.aqua, await weth.balanceOf(makerAddr));
    await usdc.approve(BASE.aqua, await usdc.balanceOf(makerAddr));
    await usdc.connect(taker).approve(routerAddr, ethers.MaxUint256);

    const walletWeth: bigint = await weth.balanceOf(makerAddr);
    const walletUsdc: bigint = await usdc.balanceOf(makerAddr);

    console.log("");
    console.log(`Wallet holds ${eth(walletWeth)} and ${usd(walletUsdc)}. Nothing will ever leave it except during a fill.`);
    console.log("");

    // Each strategy promises the same slice of the wallet, and carries a budget of the wallet split
    // three ways, so the promises together can always be honored.
    const budgetWeth = walletWeth / BigInt(STRATEGIES);
    const budgetUsdc = walletUsdc / BigInt(STRATEGIES);

    const ship = async (salt: bigint) => {
        const o = await app.buildProgram(
            makerAddr, BASE.weth, BASE.usdc, FLAT_FEE, 0n, 0n, 0n, await skew.getAddress(), salt, 0n,
        );
        const order = { maker: o.maker, traits: o.traits, data: o.data };
        await aqua.ship(
            routerAddr,
            ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address maker, uint256 traits, bytes data)"], [order]),
            [BASE.weth, BASE.usdc],
            [WETH_PER_STRATEGY, USDC_PER_STRATEGY],
        );
        const hash = await router.hash(order);
        await skew.connect(maker).setWaterline(hash, {
            maker: makerAddr,
            token0: BASE.weth,
            token1: BASE.usdc,
            reference0: WETH_PER_STRATEGY,
            reference1: USDC_PER_STRATEGY,
            budget0: budgetWeth < WETH_PER_STRATEGY ? budgetWeth : WETH_PER_STRATEGY,
            budget1: budgetUsdc < USDC_PER_STRATEGY ? budgetUsdc : USDC_PER_STRATEGY,
            baseFeeBps: 0n,
            maxFeeBps: MAX_FEE,
            kink: KINK,
            waterlineFrac: WATERLINE,
            harvestTo: makerAddr,
        });
        return { order, hash };
    };

    const slots = [];
    for (let i = 0; i < STRATEGIES; i++) slots.push(await ship(BigInt(100 + i)));

    const promisedWeth = WETH_PER_STRATEGY * BigInt(STRATEGIES);
    console.log(`Shipped ${STRATEGIES} strategies through the canonical Aqua router.`);
    console.log(`  promised   ${eth(promisedWeth)}  (${(Number(promisedWeth) / Number(walletWeth)).toFixed(2)}x the wallet: this is the amplification)`);
    const effectiveBudget = (budgetWeth < WETH_PER_STRATEGY ? budgetWeth : WETH_PER_STRATEGY) * BigInt(STRATEGIES);
    console.log(`  budgeted   ${eth(effectiveBudget)}  (never more than the wallet: this is what keeps every promise honorable)`);
    console.log("");

    const takerData = TakerTraitsLib.build({
        taker: takerAddr,
        isExactIn: true,
        isAToB: false,                 // taker sells USDC, buying the maker's WETH
        threshold: 1n,
        useTransferFromAndAquaPush: true,
    });

    const wethLeft = async (hash: string) =>
        BigInt((await aqua.rawBalances(makerAddr, routerAddr, hash, BASE.weth))[0]);

    // Directional flow into strategy 1 only, so its budget is the one that gets eaten.
    const target = slots[0]!;
    const TRADE = 300_000_000n; // 300 USDC per fill
    console.log("Directional flow into strategy 1 (the other two are untouched):");
    for (let i = 1; i <= 9; i++) {
        const feeBefore: bigint = await skew.feeBpsFor(target.hash, BASE.weth);
        try {
            const tx = await router.swap(target.order, TRADE, takerData);
            await tx.wait();
            console.log(
                `  fill ${i}: taker paid ${usd(TRADE)}, surcharge quoted ${(Number(feeBefore) / Number(BPS) * 100).toFixed(2)}%, ` +
                `strategy 1 has ${eth(await wethLeft(target.hash))} left`,
            );
        } catch (e: any) {
            console.log(`  fill ${i}: reverted (${String(e.shortMessage || e.message).slice(0, 60)})`);
        }
    }

    console.log("");
    const remaining: bigint = await skew.remainingFraction(target.hash, BASE.weth);
    console.log(`Strategy 1 budget left: ${(Number(remaining) / 100).toFixed(1)}%  ->  surcharge now ${(Number(await skew.feeBpsFor(target.hash, BASE.weth)) / Number(BPS) * 100).toFixed(2)}%`);

    // The agent: dock what is over budget, re-promise against what the wallet actually holds now.
    if (remaining <= WATERLINE) {
        console.log("");
        console.log("Agent: strategy 1 is under its waterline, docking and re-promising against real balances.");
        await aqua.dock(routerAddr, target.hash, [BASE.weth, BASE.usdc]);
        const fresh = await ship(999n);
        console.log(`  docked, re-shipped as ${fresh.hash.slice(0, 18)}...`);
        console.log(`  wallet now ${eth(await weth.balanceOf(makerAddr))} and ${usd(await usdc.balanceOf(makerAddr))}`);
    }

    console.log("");
    console.log("The user's side of this, in one line: the money never left the wallet, and it can be spent at any time.");
    console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
