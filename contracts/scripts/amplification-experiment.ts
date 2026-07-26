// SPDX-License-Identifier: MIT
//
// Does managing shared-liquidity risk actually pay, or is it just prudent?
//
// Aqua lets a maker promise the same wallet balance to N strategies at once (verified: Aqua.ship
// records the promise without checking wallet balance or allowance, Aqua.sol:40-52). Amplification
// is free while flow round-trips and expensive when flow turns directional, because the maker's
// other strategies keep quoting against inventory that is already gone.
//
// This measures that. A trending external price, an arbitrageur that only trades when the maker's
// quote is stale enough to be profitable, and the maker's P&L marked at the final price against
// simply holding. Two arms per amplification level:
//
//   unmanaged  N plain strategies, promises never resynced, nothing ever docked
//   managed    N skewed strategies + an autopilot that docks and re-promises at real balances
//
//   npx hardhat run scripts/amplification-experiment.ts
//
import { deployContract, ether } from "@1inch/solidity-utils";
import { deployFixture } from "../test/utils/fixtures";
import { TakerTraitsLib } from "../test/utils/SwapVMHelpers";

const { ethers } = require("hardhat");

const BPS = 1_000_000_000n;
const FRAC = 10_000n;
const WAD = ether("1");

// Skew curve for the managed arm.
const BASE_FEE = 0n;
const MAX_FEE = BPS / 2n;
const KINK = 4_000n;
const WATERLINE = 1_000n;

const WALLET = ether("100");            // real inventory per token
const PROMISE = WALLET;                  // each strategy promises the whole wallet, so SLAC == N
const STEPS = 40;                        // arbitrage opportunities over the trend
const TRADE = ether("10");               // tokenB the arb offers per attempt
const P_START = WAD;                     // external price of tokenA, in tokenB
const P_END = 2n * WAD;                  // trending market: tokenA doubles
const AMPLIFICATIONS = [1, 2, 4];
const FLAT_FEE = 3_000_000n;             // 0.3% trading fee, the maker's revenue
const NOISE = ether("5");                // round-tripping flow per strategy per step
const TOLERANCE = 100n;                  // ordinary flow accepts 1% worse than the external price

const f = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d);

// External price at step i, linear from P_START to P_END.
function priceAt(i: number): bigint {
    return P_START + ((P_END - P_START) * BigInt(i)) / BigInt(STEPS);
}

async function runArm(managed: boolean, amplification: number) {
    const { accounts, tokens, contracts } = await deployFixture();
    const maker = accounts.maker!;
    const { tokenA, tokenB } = tokens;
    const { aqua, swapVM, mockTaker } = contracts;

    const app: any = await deployContract("DocaApp", [await aqua.getAddress()]);
    const skew: any = await deployContract("InventorySkewProvider", [
        await aqua.getAddress(),
        await swapVM.getAddress(),
    ]);

    const makerAddr = await maker.getAddress();
    const treasury = await accounts.feeReceiver!.getAddress();
    const routerAddr = await swapVM.getAddress();
    const aAddr = await tokenA.getAddress();
    const bAddr = await tokenB.getAddress();
    const skewAddr = managed ? await skew.getAddress() : ethers.ZeroAddress;

    // The maker holds exactly WALLET of each token. Nothing more is ever added.
    await tokenA.mint(makerAddr, WALLET);
    await tokenB.mint(makerAddr, WALLET);
    await tokenA.connect(maker).approve(await aqua.getAddress(), ethers.MaxUint256);
    await tokenB.connect(maker).approve(await aqua.getAddress(), ethers.MaxUint256);
    // Deep pockets for takers so their own funding never limits the experiment.
    await tokenB.mint(await mockTaker.getAddress(), ether("100000"));
    await tokenA.mint(await mockTaker.getAddress(), ether("100000"));

    const takerData = TakerTraitsLib.build({
        taker: await mockTaker.getAddress(),
        isExactIn: true,
        isAToB: false,                    // arb sells tokenB, buys the maker's tokenA
        threshold: 1n,
        hasPreTransferInCallback: true,
        preTransferInCallbackData: "0x",
    });

    let salt = 1n;
    const slots: { order: any; hash: string; promiseA: bigint }[] = [];

    // The reference the skew measures against is NOT the promise, it is the strategy's pro-rata
    // budget of the maker's real inventory. Promises can exceed the wallet (that is the point of
    // Aqua), but the sum of budgets cannot, so honoring every promise stays possible and the skew
    // engages exactly when a strategy starts eating more than its share.
    const budget = WALLET / BigInt(amplification);

    const shipSlot = async (promiseA: bigint, promiseB: bigint) => {
        const o = await app.buildProgram(makerAddr, aAddr, bAddr, FLAT_FEE, 0n, 0n, 0n, skewAddr, salt++, 0n);
        const order = { maker: o.maker, traits: o.traits, data: o.data };
        await aqua.connect(maker).ship(
            routerAddr,
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["tuple(address maker, uint256 traits, bytes data)"], [order],
            ),
            [aAddr, bAddr],
            [promiseA, promiseB],
        );
        const hash = await swapVM.hash(order);
        if (managed) {
            await skew.connect(maker).setWaterline(hash, {
                maker: makerAddr,
                token0: aAddr,
                token1: bAddr,
                reference0: promiseA,
                reference1: promiseB,
                budget0: budget < promiseA ? budget : promiseA,
                budget1: budget < promiseB ? budget : promiseB,
                baseFeeBps: BASE_FEE,
                maxFeeBps: MAX_FEE,
                kink: KINK,
                waterlineFrac: WATERLINE,
                harvestTo: treasury,      // the maker's own treasury, counted in P&L below
            });
        }
        return { order, hash, promiseA };
    };

    for (let i = 0; i < amplification; i++) slots.push(await shipSlot(PROMISE, PROMISE));

    const reverseData = TakerTraitsLib.build({
        taker: await mockTaker.getAddress(),
        isExactIn: true,
        isAToB: true,                     // noise trader selling tokenA back to the maker
        threshold: 1n,
        hasPreTransferInCallback: true,
        preTransferInCallbackData: "0x",
    });

    let fills = 0, reverts = 0, docks = 0, extracted = 0n, noiseFills = 0;

    for (let step = 0; step < STEPS; step++) {
        const pExt = priceAt(step);

        for (const slot of slots) {
            // The arbitrageur only trades when the maker's quote is below the external price.
            let out: bigint;
            try {
                // quote is non-view in SwapVM (it runs the program), so simulate it.
                const res = await swapVM.quote.staticCall(slot.order, TRADE, takerData);
                out = BigInt(res[1]);
            } catch { continue; }
            if (out === 0n) continue;

            const pQuoted = (TRADE * WAD) / out;      // tokenB paid per tokenA received
            if (pQuoted >= pExt) continue;            // nothing to extract, arb walks away

            try {
                await mockTaker.swap(slot.order, TRADE, takerData);
                fills++;
                // What the arb made: tokenA bought below the external price.
                extracted += (out * (pExt - pQuoted)) / WAD;
            } catch {
                reverts++;                            // quoted liquidity that was not really there
            }
        }

        // Ordinary two-sided flow: this is where the maker's fee revenue comes from, and it is the
        // reason amplification is attractive at all. It round-trips, so it barely moves inventory.
        for (const slot of slots) {
            // Buying tokenA: accepted only if the ask is within tolerance of the external price.
            try {
                const res = await swapVM.quote.staticCall(slot.order, NOISE, takerData);
                const out = BigInt(res[1]);
                if (out > 0n) {
                    const ask = (NOISE * WAD) / out;
                    if (ask <= (pExt * (10_000n + TOLERANCE)) / 10_000n) {
                        await mockTaker.swap(slot.order, NOISE, takerData);
                        noiseFills++;
                    }
                }
            } catch { reverts++; }

            // Selling tokenA back: accepted only if the bid is within tolerance.
            try {
                const res = await swapVM.quote.staticCall(slot.order, NOISE, reverseData);
                const out = BigInt(res[1]);
                if (out > 0n) {
                    const bid = (out * WAD) / NOISE;
                    if (bid >= (pExt * (10_000n - TOLERANCE)) / 10_000n) {
                        await mockTaker.swap(slot.order, NOISE, reverseData);
                        noiseFills++;
                    }
                }
            } catch { reverts++; }
        }

        if (!managed) continue;

        // Autopilot: dock any strategy under its waterline and re-promise against real balances.
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i]!;
            const remaining: bigint = await skew.remainingFraction(slot.hash, aAddr);
            if (remaining > WATERLINE) continue;

            await aqua.connect(maker).dock(routerAddr, slot.hash, [aAddr, bAddr]);
            docks++;

            const realA: bigint = await tokenA.balanceOf(makerAddr);
            const realB: bigint = await tokenB.balanceOf(makerAddr);
            if (realA === 0n || realB === 0n) { slots.splice(i, 1); i--; continue; }
            // Re-promise at real balances: the autopilot resynchronizes promises with reality.
            slots[i] = await shipSlot(realA, realB);
        }
    }

    // The maker's position is wallet plus whatever the skew harvested into their treasury.
    const finalA: bigint = (await tokenA.balanceOf(makerAddr)) + (await tokenA.balanceOf(treasury));
    const finalB: bigint = (await tokenB.balanceOf(makerAddr)) + (await tokenB.balanceOf(treasury));
    const pFinal = priceAt(STEPS);

    const endValue = (finalA * pFinal) / WAD + finalB;
    const hodl = (WALLET * pFinal) / WAD + WALLET;

    return { fills, noiseFills, reverts, docks, extracted, finalA, finalB, endValue, hodl };
}

async function main() {
    console.log("");
    console.log(`Trending market: tokenA goes ${f(P_START)} -> ${f(P_END)} over ${STEPS} steps.`);
    console.log(`Maker holds ${f(WALLET)} of each token and promises ${f(PROMISE)} to EVERY strategy, so SLAC = N.`);
    console.log(`An arbitrageur attempts ${f(TRADE)} tokenB per strategy per step, and only trades when the quote is stale.`);
    console.log("");
    console.log("|   N | arm       | arb fills | flow fills | reverts | docks | arb extracted | LP end value | vs HODL |");
    console.log("|----:|-----------|----------:|-----------:|--------:|------:|--------------:|-------------:|--------:|");

    const rows: any[] = [];
    for (const n of AMPLIFICATIONS) {
        for (const managed of [false, true]) {
            const r = await runArm(managed, n);
            const vsHodl = r.endValue - r.hodl;
            const vsHodlPct = (Number(vsHodl) / Number(r.hodl)) * 100;
            rows.push({ n, managed, ...r, vsHodl, vsHodlPct });
            console.log(
                `| ${String(n).padStart(3)} | ${(managed ? "managed" : "unmanaged").padEnd(9)} | ` +
                `${String(r.fills).padStart(9)} | ${String(r.noiseFills).padStart(10)} | ${String(r.reverts).padStart(7)} | ${String(r.docks).padStart(5)} | ` +
                `${f(r.extracted).padStart(13)} | ${f(r.endValue).padStart(12)} | ${(vsHodlPct.toFixed(2) + "%").padStart(7)} |`,
            );
        }
    }

    console.log("");
    console.log("Delta per amplification level (managed minus unmanaged)");
    for (const n of AMPLIFICATIONS) {
        const u = rows.find((r) => r.n === n && !r.managed)!;
        const m = rows.find((r) => r.n === n && r.managed)!;
        const gain = m.endValue - u.endValue;
        const gainPct = (Number(gain) / Number(u.endValue)) * 100;
        console.log(
            `  N=${n}  LP value ${f(u.endValue)} -> ${f(m.endValue)}  (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(2)}%)  ` +
            `| arb extracted ${f(u.extracted)} -> ${f(m.extracted)}  | reverts ${u.reverts} -> ${m.reverts}`,
        );
    }
    console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
