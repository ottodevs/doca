// SPDX-License-Identifier: MIT
//
// Runs identical taker flow against two Aqua strategies shipped from the SAME wallet, one with the
// inventory skew instruction and one without, and prints what the difference is worth. This is the
// demo's proof block: same curve, same liquidity, same flow, measured outcome.
//
//   npx hardhat run scripts/waterline-scenario.ts

import { deployContract, ether } from "@1inch/solidity-utils";
import { deployFixture } from "../test/utils/fixtures";
import { TakerTraitsLib } from "../test/utils/SwapVMHelpers";

const { ethers } = require("hardhat");

const BPS = 1_000_000_000n;
const FRAC = 10_000n;

// Curve, overridable from the environment so the economics can be swept quickly.
const BASE_FEE = BigInt(process.env.BASE_FEE ?? "0");
const MAX_FEE = BigInt(process.env.MAX_FEE ?? String(BPS / 2n));   // prohibitive at the waterline
const KINK = BigInt(process.env.KINK ?? "4000");                    // ramp starts with 40% left
const WATERLINE = BigInt(process.env.WATERLINE ?? "500");           // fully prohibitive with 5% left

const LIQUIDITY = ether("100");
const SWAPS = Number(process.env.SWAPS ?? "30");
const SWAP_SIZE = ether(process.env.SWAP_SIZE ?? "50");

const fmt = (v: bigint, decimals = 2) => (Number(v) / 1e18).toFixed(decimals);
const pct = (v: bigint) => (Number(v) / Number(FRAC) * 100).toFixed(1);

async function main() {
    const { accounts, tokens, contracts } = await deployFixture();
    const { maker, feeReceiver } = accounts;
    const { tokenA, tokenB } = tokens;
    const { aqua, swapVM, mockTaker } = contracts;

    const plimsollApp: any = await deployContract("PlimsollApp", [await aqua.getAddress()]);
    const skewProvider: any = await deployContract("InventorySkewProvider", [
        await aqua.getAddress(),
        await swapVM.getAddress(),
    ]);

    const makerAddr = await maker!.getAddress();
    const harvestTo = await feeReceiver!.getAddress();
    const routerAddr = await swapVM.getAddress();
    const tokenAAddr = await tokenA.getAddress();
    const tokenBAddr = await tokenB.getAddress();

    // One wallet balance backs both strategies at once. That is the oversubscription Aqua enables.
    await tokenA.mint(makerAddr, ether("1000"));
    await tokenB.mint(makerAddr, ether("1000"));
    await tokenB.mint(await mockTaker.getAddress(), ether("5000"));
    await tokenA.connect(maker!).approve(await aqua.getAddress(), ethers.MaxUint256);
    await tokenB.connect(maker!).approve(await aqua.getAddress(), ethers.MaxUint256);

    const buildOrder = async (provider: string, salt: bigint) => {
        const o = await plimsollApp.buildProgram(
            makerAddr, tokenAAddr, tokenBAddr, 0n, 0n, 0n, 0n, provider, salt, 0n,
        );
        return { maker: o.maker, traits: o.traits, data: o.data };
    };

    const ship = async (order: any) => {
        await aqua.connect(maker!).ship(
            routerAddr,
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["tuple(address maker, uint256 traits, bytes data)"], [order],
            ),
            [tokenAAddr, tokenBAddr],
            [LIQUIDITY, LIQUIDITY],
        );
        return await swapVM.hash(order);
    };

    const skewed = await buildOrder(await skewProvider.getAddress(), 100n);
    const plain = await buildOrder(ethers.ZeroAddress, 101n);
    const skewedHash = await ship(skewed);
    const plainHash = await ship(plain);

    await skewProvider.connect(maker!).setWaterline(skewedHash, {
        maker: makerAddr,
        token0: tokenAAddr,
        token1: tokenBAddr,
        reference0: LIQUIDITY,
        reference1: LIQUIDITY,
        budget0: 0n,
        budget1: 0n,
        baseFeeBps: BASE_FEE,
        maxFeeBps: MAX_FEE,
        kink: KINK,
        waterlineFrac: WATERLINE,
        harvestTo,
    });

    const takerData = TakerTraitsLib.build({
        taker: await mockTaker.getAddress(),
        isExactIn: true,
        isAToB: false,          // taker sells tokenB, draining the maker's tokenA
        threshold: 1n,
        hasPreTransferInCallback: true,
        preTransferInCallbackData: "0x",
    });

    const balances = async (hash: string) => {
        const [a] = await aqua.rawBalances(makerAddr, routerAddr, hash, tokenAAddr);
        const [b] = await aqua.rawBalances(makerAddr, routerAddr, hash, tokenBAddr);
        return { a: BigInt(a), b: BigInt(b) };
    };

    console.log("");
    console.log(`Identical flow: ${SWAPS} swaps of ${fmt(SWAP_SIZE)} tokenB into a ${fmt(LIQUIDITY)}/${fmt(LIQUIDITY)} strategy.`);
    console.log("Both strategies shipped from the same wallet. Only difference: the skew instruction.");
    console.log("");
    console.log("| swap | plain: tokenA left | skew: tokenA left | quoted surcharge | harvested tokenB |");
    console.log("|-----:|-------------------:|------------------:|-----------------:|-----------------:|");

    for (let i = 1; i <= SWAPS; i++) {
        const fee: bigint = await skewProvider.feeBpsFor(skewedHash, tokenAAddr);

        await mockTaker.swap(plain, SWAP_SIZE, takerData);
        await mockTaker.swap(skewed, SWAP_SIZE, takerData);

        const p = await balances(plainHash);
        const s = await balances(skewedHash);
        const harvested: bigint = await tokenB.balanceOf(harvestTo);
        const feePct = (Number(fee) / Number(BPS) * 100).toFixed(3);

        console.log(`| ${String(i).padStart(4)} | ${fmt(p.a).padStart(18)} | ${fmt(s.a).padStart(17)} | ${(feePct + "%").padStart(16)} | ${fmt(harvested, 4).padStart(16)} |`);
    }

    const p = await balances(plainHash);
    const s = await balances(skewedHash);
    const harvested: bigint = await tokenB.balanceOf(harvestTo);

    const plainRemaining = p.a * FRAC / LIQUIDITY;
    const skewRemaining = s.a * FRAC / LIQUIDITY;

    // Realized price on the drained leg: how much tokenB the maker took in per tokenA given up.
    const plainSold = LIQUIDITY - p.a;
    const skewSold = LIQUIDITY - s.a;
    const plainPrice = (p.b - LIQUIDITY) * ether("1") / plainSold;
    const skewPrice = (s.b + harvested - LIQUIDITY) * ether("1") / skewSold;

    console.log("");
    console.log("Outcome");
    console.log(`  inventory left, plain      ${fmt(p.a)} tokenA  (${pct(plainRemaining)}% of shipped)`);
    console.log(`  inventory left, skew       ${fmt(s.a)} tokenA  (${pct(skewRemaining)}% of shipped)`);
    console.log(`  inventory defended         ${fmt(s.a - p.a)} tokenA  (+${(Number(skewRemaining - plainRemaining) / 100).toFixed(1)} points)`);
    console.log(`  realized price, plain      ${fmt(plainPrice, 4)} tokenB per tokenA`);
    console.log(`  realized price, skew       ${fmt(skewPrice, 4)} tokenB per tokenA`);
    console.log(`  price improvement          ${((Number(skewPrice - plainPrice) / Number(plainPrice)) * 100).toFixed(2)}%`);
    console.log(`  harvested out of the pool  ${fmt(harvested, 4)} tokenB`);
    console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
