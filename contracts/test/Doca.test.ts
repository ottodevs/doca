// SPDX-License-Identifier: MIT

import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Signer } from "ethers";
import { expect, deployContract, ether } from "@1inch/solidity-utils";

import { deployFixture } from "./utils/fixtures";
import { TakerTraitsLib } from "./utils/SwapVMHelpers";

const { ethers } = require("hardhat");

/// SwapVM fee denominator: 1e9 == 100%.
const BPS = 1_000_000_000n;
/// Inventory fractions are expressed against 1e4.
const FRAC = 10_000n;

const BASE_FEE = 0n;                 // nothing extra while inventory is healthy
const MAX_FEE = BPS / 20n;           // 5% at the waterline
const KINK = 5_000n;                 // ramp starts once half the shipped inventory is gone
const WATERLINE = 1_000n;            // full surcharge with 10% of inventory left

describe("Doca — inventory skew on Aqua/SwapVM", function () {
    async function setupFixture() {
        const base = await deployFixture();
        const { accounts, tokens, contracts } = base;

        const docaApp: any = await deployContract("DocaApp", [await contracts.aqua.getAddress()]);
        const skewProvider: any = await deployContract("InventorySkewProvider", [
            await contracts.aqua.getAddress(),
            await contracts.swapVM.getAddress(),
        ]);

        // The maker holds one wallet balance; both strategies below draw on it concurrently, which is
        // exactly the oversubscription Aqua enables and this contract prices.
        await tokens.tokenA.mint(await accounts.maker.getAddress(), ether("1000"));
        await tokens.tokenB.mint(await accounts.maker.getAddress(), ether("1000"));
        await tokens.tokenB.mint(await contracts.mockTaker.getAddress(), ether("5000"));

        await tokens.tokenA.connect(accounts.maker).approve(await contracts.aqua.getAddress(), ethers.MaxUint256);
        await tokens.tokenB.connect(accounts.maker).approve(await contracts.aqua.getAddress(), ethers.MaxUint256);

        return { ...base, contracts: { ...contracts, docaApp, skewProvider } };
    }

    async function buildOrder(
        docaApp: any,
        maker: Signer,
        tokenA: any,
        tokenB: any,
        skewProvider: string,
        salt: bigint,
    ) {
        const order = await docaApp.buildProgram(
            await maker.getAddress(),
            await tokenA.getAddress(),
            await tokenB.getAddress(),
            0n,                       // no flat fee: isolate the inventory skew in the assertions
            0n,                       // full range
            0n,
            0n,                       // no decay
            skewProvider,
            salt,
            0n,
        );
        return { maker: order.maker, traits: order.traits, data: order.data };
    }

    async function ship(
        contracts: any,
        maker: Signer,
        order: any,
        tokenA: any,
        tokenB: any,
        liquidity: bigint,
    ) {
        await contracts.aqua.connect(maker).ship(
            await contracts.swapVM.getAddress(),
            ethers.AbiCoder.defaultAbiCoder().encode(
                ["tuple(address maker, uint256 traits, bytes data)"],
                [order],
            ),
            [await tokenA.getAddress(), await tokenB.getAddress()],
            [liquidity, liquidity],
        );
        return await contracts.swapVM.hash(order);
    }

    async function setWaterline(
        skewProvider: any,
        maker: Signer,
        orderHash: string,
        tokenA: any,
        tokenB: any,
        harvestTo: string,
        reference: bigint,
    ) {
        await skewProvider.connect(maker).setWaterline(orderHash, {
            maker: await maker.getAddress(),
            token0: await tokenA.getAddress(),
            token1: await tokenB.getAddress(),
            reference0: reference,
            reference1: reference,
            budget0: 0n,
            budget1: 0n,
            baseFeeBps: BASE_FEE,
            maxFeeBps: MAX_FEE,
            kink: KINK,
            waterlineFrac: WATERLINE,
            harvestTo,
        });
    }

    /// Taker sells tokenB for tokenA, which drains the maker's tokenA inventory.
    async function drain(contracts: any, order: any, amountIn: bigint) {
        return contracts.mockTaker.swap(
            order,
            amountIn,
            TakerTraitsLib.build({
                taker: await contracts.mockTaker.getAddress(),
                isExactIn: true,
                isAToB: false,
                threshold: 1n,
                hasPreTransferInCallback: true,
                preTransferInCallbackData: "0x",
            }),
        );
    }

    it("quotes the base fee while inventory is healthy", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");

        const order = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 1n);
        const orderHash = await ship(contracts, maker, order, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, orderHash, tokenA, tokenB, await feeReceiver.getAddress(), liquidity);

        expect(await contracts.skewProvider.remainingFraction(orderHash, await tokenA.getAddress())).to.equal(FRAC);
        expect(await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress())).to.equal(BASE_FEE);
    });

    it("ramps the surcharge convexly as the outgoing leg drains, and caps it at the waterline", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");

        const order = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 2n);
        const orderHash = await ship(contracts, maker, order, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, orderHash, tokenA, tokenB, await feeReceiver.getAddress(), liquidity);

        // x*y=k with 100/100: selling 100 tokenB takes tokenA to ~50, i.e. right at the kink.
        await drain(contracts, order, ether("110"));
        const midFee: bigint = await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress());
        const midRemaining: bigint = await contracts.skewProvider.remainingFraction(orderHash, await tokenA.getAddress());
        expect(midRemaining).to.be.lt(KINK);
        expect(midFee).to.be.gt(BASE_FEE);
        expect(midFee).to.be.lt(MAX_FEE);

        // Convexity: at the midpoint of the ramp the surcharge is a quarter of the maximum, not half.
        const travelled = KINK - midRemaining;
        const span = KINK - WATERLINE;
        const expected = (MAX_FEE - BASE_FEE) * travelled * travelled / (span * span);
        expect(midFee).to.equal(BASE_FEE + expected);

        // Push it under the waterline: the surcharge caps out.
        await drain(contracts, order, ether("900"));
        expect(await contracts.skewProvider.remainingFraction(orderHash, await tokenA.getAddress())).to.be.lte(WATERLINE);
        expect(await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress())).to.equal(MAX_FEE);
    });

    it("is directional: replenishing the drained leg stays at the base fee", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");

        const order = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 3n);
        const orderHash = await ship(contracts, maker, order, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, orderHash, tokenA, tokenB, await feeReceiver.getAddress(), liquidity);

        await drain(contracts, order, ether("300"));

        // tokenA is scarce, so taking it is surcharged...
        expect(await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress())).to.be.gt(BASE_FEE);
        // ...while trading in the direction that refills tokenA is untouched.
        expect(await contracts.skewProvider.feeBpsFor(orderHash, await tokenB.getAddress())).to.equal(BASE_FEE);
    });

    it("defends inventory against identical flow and harvests the surcharge out of the shared pool", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");
        const harvestTo = await feeReceiver.getAddress();

        // Same curve, same liquidity, same wallet. The only difference is the skew instruction.
        const skewed = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 10n);
        const plain = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, ethers.ZeroAddress, 11n);

        const skewedHash = await ship(contracts, maker, skewed, tokenA, tokenB, liquidity);
        const plainHash = await ship(contracts, maker, plain, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, skewedHash, tokenA, tokenB, harvestTo, liquidity);

        const flow = [ether("60"), ether("60"), ether("60")];
        for (const amountIn of flow) {
            await drain(contracts, plain, amountIn);
        }

        // The last swap on the defended strategy moves real ERC20s, not virtual balances only.
        for (const amountIn of flow.slice(0, -1)) {
            await drain(contracts, skewed, amountIn);
        }
        // The surcharge is quoted from the inventory state as it stands before the swap.
        const last = flow[flow.length - 1];
        const feeBps: bigint = await contracts.skewProvider.feeBpsFor(skewedHash, await tokenA.getAddress());
        expect(feeBps).to.be.gt(BASE_FEE);

        await expect(drain(contracts, skewed, last)).to.changeTokenBalances(
            tokenB,
            [await contracts.mockTaker.getAddress(), harvestTo],
            [-last, feeBps * last / BPS],
        );

        const [skewedA] = await contracts.aqua.rawBalances(
            await maker.getAddress(), await contracts.swapVM.getAddress(), skewedHash, await tokenA.getAddress(),
        );
        const [plainA] = await contracts.aqua.rawBalances(
            await maker.getAddress(), await contracts.swapVM.getAddress(), plainHash, await tokenA.getAddress(),
        );

        // Identical flow, more inventory left standing.
        expect(skewedA).to.be.gt(plainA);
        // And the surcharge is now sitting outside the shared pool.
        expect(await tokenB.balanceOf(harvestTo)).to.be.gt(0n);
    });
});
