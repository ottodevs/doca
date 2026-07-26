// SPDX-License-Identifier: MIT

import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Signer } from "ethers";
import { expect, deployContract, ether } from "@1inch/solidity-utils";

import { deployFixture } from "./utils/fixtures";
import { TakerTraitsLib } from "./utils/SwapVMHelpers";

const { ethers } = require("hardhat");

/// These tests document current behavior, including its limits. None of them exercise an
/// enforcement mechanism that does not exist yet -- InventorySkewProvider prices depletion, it does
/// not cap fills or guard against a drained wallet. Where that gap matters, the test comments say so
/// and point at the "next layer" writeup in the README instead of pretending a guard is in place.

/// SwapVM fee denominator: 1e9 == 100%.
const BPS = 1_000_000_000n;
/// Inventory fractions are expressed against 1e4.
const FRAC = 10_000n;

const BASE_FEE = BPS / 200n;         // 0.5% while inventory is healthy, nonzero so a discount is visible
const MAX_FEE = BPS / 20n;           // 5% at the waterline
const KINK = 5_000n;                 // ramp starts once half the shipped inventory is gone
const WATERLINE = 1_000n;            // full surcharge with 10% of inventory left

describe("Doca: adversarial scenarios on Aqua/SwapVM", function () {
    async function setupFixture() {
        const base = await deployFixture();
        const { accounts, tokens, contracts } = base;

        const docaApp: any = await deployContract("DocaApp", [await contracts.aqua.getAddress()]);
        const skewProvider: any = await deployContract("InventorySkewProvider", [
            await contracts.aqua.getAddress(),
            await contracts.swapVM.getAddress(),
        ]);

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

    /// Taker sells tokenB for tokenA, which drains the maker's tokenA inventory -- the leg the
    /// waterline in these tests is registered against.
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

    it("prices a single large fill from the pre-fill inventory state, not the post-trade state it lands in", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");
        const harvestTo = await feeReceiver.getAddress();

        const order = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 201n);
        const orderHash = await ship(contracts, maker, order, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, orderHash, tokenA, tokenB, harvestTo, liquidity);

        // Fully stocked: base fee.
        const preFillFee: bigint = await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress());
        expect(preFillFee).to.equal(BASE_FEE);

        // One trade, sized to jump straight from fully stocked to past the waterline in a single
        // shot (x*y=k on a 100/100 pool: selling ~1200 tokenB, net of the flat fee, takes tokenA
        // reserves from 100 to under 8). There is no intermediate quote inside a single fill -- the
        // provider is called once, before the trade executes.
        const amountIn = ether("1200");
        await expect(drain(contracts, order, amountIn)).to.changeTokenBalances(
            tokenB,
            [await contracts.mockTaker.getAddress(), harvestTo],
            [-amountIn, preFillFee * amountIn / BPS],
        );

        // Post-trade the position is well past the waterline, where a fresh quote would charge the
        // max rate.
        const postFillRemaining: bigint = await contracts.skewProvider.remainingFraction(orderHash, await tokenA.getAddress());
        const postFillFee: bigint = await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress());
        expect(postFillRemaining).to.be.lt(WATERLINE);
        expect(postFillFee).to.equal(MAX_FEE);

        // But the fill that got it there was charged the pre-fill base rate (0.5%), not the max rate
        // (5%) its own resulting state would justify. InventorySkewProvider prices cumulative
        // depletion measured before the swap; it has no notion of "this fill, by itself, is what
        // crosses the waterline." A single fill can cross the waterline while paying less than the
        // post-trade state would warrant. Pricing the *projected* post-trade state instead of the
        // pre-fill state is exactly the gap the BudgetGuard instruction sketched in the README would
        // close -- see "The next layer: a BudgetGuard instruction".
        expect(preFillFee).to.be.lt(postFillFee);
    });

    it("keeps quoting the base fee after an external wallet spend, then reverts at settlement once the real balance can't cover the fill", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");
        const harvestTo = await feeReceiver.getAddress();
        const signers = await ethers.getSigners();
        const externalRecipient: Signer = signers[4];

        const order = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 301n);
        const orderHash = await ship(contracts, maker, order, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, orderHash, tokenA, tokenB, harvestTo, liquidity);

        // The maker's wallet holds ether("1000") tokenA from the fixture. Spend almost all of it
        // externally -- a plain ERC20 transfer, not routed through Aqua at all. Aqua never takes
        // custody of the maker's tokens (that is the point of the shared-liquidity design), so it has
        // no way to see this happen.
        await tokenA.connect(maker).transfer(await externalRecipient.getAddress(), ether("970"));
        expect(await tokenA.balanceOf(await maker.getAddress())).to.equal(ether("30"));

        // InventorySkewProvider prices off Aqua's virtual ledger (`rawBalances`), which the external
        // transfer never touched. It still reports the strategy as fully stocked and quotes the base
        // fee, even though the maker now holds far less tokenA than the strategy has promised.
        expect(await contracts.skewProvider.remainingFraction(orderHash, await tokenA.getAddress())).to.equal(FRAC);
        expect(await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress())).to.equal(BASE_FEE);

        // A fill sized within what's actually left in the wallet settles normally at the base fee, as
        // if the external spend never happened -- the curve has no signal that it did.
        await drain(contracts, order, ether("40"));
        const realBalanceAfterSmallFill = await tokenA.balanceOf(await maker.getAddress());
        expect(realBalanceAfterSmallFill).to.be.gt(0n);
        expect(await contracts.skewProvider.feeBpsFor(orderHash, await tokenA.getAddress())).to.equal(BASE_FEE);

        // A fill sized against the strategy's promised inventory rather than the maker's real balance
        // asks Aqua to pull more tokenA than the wallet actually holds. Nothing in the fee curve or
        // the AMM math catches this ahead of time -- the strategy's own virtual ledger still has
        // budget left, so the trade is accepted and only fails when the ERC20 transferFrom underneath
        // Aqua.pull() runs out of real balance. The observed behavior is a hard revert at settlement
        // with Aqua's own SafeTransferFromFailed error, not a graceful partial fill and not an early
        // revert from the pricing layer.
        await expect(drain(contracts, order, ether("900")))
            .to.be.revertedWithCustomError(contracts.aqua, "SafeTransferFromFailed");
    });

    it("prices two strategies against the same wallet independently, so their combined draw can starve one while the other still reports itself healthy", async function () {
        const { accounts: { maker, feeReceiver }, tokens: { tokenA, tokenB }, contracts } = await loadFixture(setupFixture);
        const liquidity = ether("100");
        const harvestTo = await feeReceiver.getAddress();
        const signers = await ethers.getSigners();
        const externalRecipient: Signer = signers[4];

        // Cap the maker's real tokenA down to 120, well under the 200 that two strategies each
        // promising 100 will together claim to have available. This is the oversubscription Aqua is
        // built for: one wallet balance backing several strategies at once.
        await tokenA.connect(maker).transfer(await externalRecipient.getAddress(), ether("880"));
        expect(await tokenA.balanceOf(await maker.getAddress())).to.equal(ether("120"));

        const strategyA = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 401n);
        const strategyB = await buildOrder(contracts.docaApp, maker, tokenA, tokenB, await contracts.skewProvider.getAddress(), 402n);
        const hashA = await ship(contracts, maker, strategyA, tokenA, tokenB, liquidity);
        const hashB = await ship(contracts, maker, strategyB, tokenA, tokenB, liquidity);
        await setWaterline(contracts.skewProvider, maker, hashA, tokenA, tokenB, harvestTo, liquidity);
        await setWaterline(contracts.skewProvider, maker, hashB, tokenA, tokenB, harvestTo, liquidity);

        // Both strategies start out reading the wallet as fully stocked, independently of each other
        // and of the fact that the wallet can't actually cover both promises at once.
        expect(await contracts.skewProvider.feeBpsFor(hashA, await tokenA.getAddress())).to.equal(BASE_FEE);
        expect(await contracts.skewProvider.feeBpsFor(hashB, await tokenA.getAddress())).to.equal(BASE_FEE);

        // Drain strategy A hard enough to push it past its own waterline. This pulls real tokenA out
        // of the maker's wallet, the one thing both strategies actually share.
        await drain(contracts, strategyA, ether("1200"));
        expect(await contracts.skewProvider.remainingFraction(hashA, await tokenA.getAddress())).to.be.lt(WATERLINE);
        expect(await contracts.skewProvider.feeBpsFor(hashA, await tokenA.getAddress())).to.equal(MAX_FEE);

        // Strategy B's own ledger is untouched -- Aqua keys virtual balances by strategy hash, so B
        // has no visibility into A's consumption. It still reports fully stocked and quotes the base
        // fee, even though the shared wallet just lost most of its real tokenA to A's trade.
        expect(await contracts.skewProvider.remainingFraction(hashB, await tokenA.getAddress())).to.equal(FRAC);
        expect(await contracts.skewProvider.feeBpsFor(hashB, await tokenA.getAddress())).to.equal(BASE_FEE);

        // The real wallet is down to single digits of tokenA now, all consumed by A, none of it
        // visible in B's own budget accounting.
        const realBalanceAfterA = await tokenA.balanceOf(await maker.getAddress());
        expect(realBalanceAfterA).to.be.lt(ether("31"));
        expect(realBalanceAfterA).to.be.gt(0n);

        // A small fill through B, within what's left in the shared wallet, still settles fine at the
        // base fee -- B's own budget says it is barely touched, and locally that is true.
        await drain(contracts, strategyB, ether("25"));
        expect(await tokenA.balanceOf(await maker.getAddress())).to.be.gt(0n);

        // A fill through B sized against B's own promised inventory (which still looks nearly full)
        // rather than the wallet's actual remaining tokenA reverts at settlement. B's individual
        // budget -- and its fee curve -- never reflected the shared capacity A had already spent.
        // Neither strategy's own accounting protects against the aggregate draw on the wallet they
        // both quote against; the failure only surfaces as a hard revert on whichever fill happens to
        // hit the real floor first, with Aqua's own SafeTransferFromFailed error.
        await expect(drain(contracts, strategyB, ether("900")))
            .to.be.revertedWithCustomError(contracts.aqua, "SafeTransferFromFailed");
    });
});
