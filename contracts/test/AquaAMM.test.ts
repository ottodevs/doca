// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1

import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Signer } from 'ethers';
import { expect, ether, constants, time, timeIncreaseTo } from '@1inch/solidity-utils';

// Import fixtures and helpers
import { deployFixture } from "./utils/fixtures";
import { TakerTraitsLib } from "./utils/SwapVMHelpers";

// Import generated types for all contracts
import { Aqua } from '../typechain-types/@1inch/aqua/src/Aqua';
import { AquaAMM } from '../typechain-types/contracts/AquaAMM';
import { AquaSwapVMRouter } from '../typechain-types/@1inch/swap-vm/src/routers/AquaSwapVMRouter';
import { MockTaker } from '../typechain-types/contracts/MockTaker';
import { TokenMock } from '../typechain-types/@1inch/solidity-utils/contracts/mocks/TokenMock';

const { ethers } = require("hardhat");

interface SetupFixtureResult {
  accounts: {
    owner: Signer;
    maker: Signer;
    taker: Signer;
    feeReceiver: Signer;
  };
  tokens: {
    tokenA: TokenMock;
    tokenB: TokenMock;
  };
  contracts: {
    aqua: Aqua;
    aquaAMM: AquaAMM;
    swapVM: AquaSwapVMRouter;
    mockTaker: MockTaker;
  };
}

describe("AquaAMM", function () {
  async function setupFixture(): Promise<SetupFixtureResult> {
    const {
      accounts,
      tokens,
      contracts
    } = await deployFixture();

    // Setup token amounts
    const mintAmount = ether("1000");
    await tokens.tokenA.mint(await accounts.maker.getAddress(), mintAmount);
    await tokens.tokenB.mint(await accounts.maker.getAddress(), mintAmount);
    await tokens.tokenB.mint(await contracts.mockTaker.getAddress(), mintAmount);
    await tokens.tokenB.mint(await accounts.taker.getAddress(), mintAmount);

    // Approve tokens for maker
    await tokens.tokenA.connect(accounts.maker).approve(await contracts.aqua.getAddress(), ethers.MaxUint256);
    await tokens.tokenB.connect(accounts.maker).approve(await contracts.aqua.getAddress(), ethers.MaxUint256);

    // Note: MockTaker handles token approvals internally in its preTransferInCallback

    return {
      accounts,
      tokens,
      contracts
    };
  }

  async function buildOrder(
    aquaAMM: AquaAMM,
    maker: Signer,
    tokenA: TokenMock,
    tokenB: TokenMock,
    { salt = 0n, deadline = 0n }: { salt?: bigint; deadline?: bigint | number } = {}
  ) {
    const feeBpsIn = 0n; // No fee
    const sqrtPriceMin = 0n; // No concentration (full range)
    const sqrtPriceMax = 0n; // No concentration (full range)
    const decayPeriod = 0n; // No decay
    const protocolFeeBpsIn = 0n; // No protocol fee

    const order = await aquaAMM.buildProgram(
      await maker.getAddress(),
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      feeBpsIn,
      sqrtPriceMin,
      sqrtPriceMax,
      decayPeriod,
      protocolFeeBpsIn,
      constants.ZERO_ADDRESS, // No fee receiver
      salt,
      deadline
    );

    // Create a new object to avoid read-only issues
    return { maker: order.maker, traits: order.traits, data: order.data };
  }

  async function shipLiquidity(
    aqua: Aqua,
    maker: Signer,
    swapVM: AquaSwapVMRouter,
    orderStruct: { maker: string; traits: bigint; data: string },
    tokenA: TokenMock,
    tokenB: TokenMock,
    liquidityA: bigint,
    liquidityB: bigint
  ) {
    await aqua.connect(maker).ship(
      await swapVM.getAddress(),
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address maker, uint256 traits, bytes data)"],
        [orderStruct]
      ),
      [await tokenA.getAddress(), await tokenB.getAddress()],
      [liquidityA, liquidityB]
    );
  }

  describe("XYC Swap with AquaAMM", function () {
    it("should execute swap with resolver contract", async function () {
      const {
        accounts: { maker },
        tokens: { tokenA, tokenB },
        contracts: { aqua, aquaAMM, swapVM, mockTaker }
      } = await loadFixture(setupFixture);

      const orderStruct = await buildOrder(aquaAMM, maker, tokenA, tokenB);

      // Ship liquidity to Aqua
      await shipLiquidity(aqua, maker, swapVM, orderStruct, tokenA, tokenB, ether("100"), ether("200"));

      // Build taker traits data: swap tokenB -> tokenA (isAToB = false)
      const takerData = TakerTraitsLib.build({
        taker: await mockTaker.getAddress(),
        isExactIn: true,
        isAToB: false,
        threshold: ether("15"),
        hasPreTransferInCallback: true,
        preTransferInCallbackData: "0x" // Empty callback data
      });

      const amountIn = ether("50");

      const tx = await mockTaker.swap(
        orderStruct,
        amountIn,
        takerData
      );

      await expect(tx).to.changeTokenBalances(
        tokenB,
        [await mockTaker.getAddress(), await maker.getAddress()],
        [-amountIn, amountIn]
      );
    });

    it("should execute swap with EOA as taker", async function () {
      const {
        accounts: { maker, taker },
        tokens: { tokenA, tokenB },
        contracts: { aqua, aquaAMM, swapVM }
      } = await loadFixture(setupFixture);

      const orderStruct = await buildOrder(aquaAMM, maker, tokenA, tokenB, { salt: 1n });

      await shipLiquidity(aqua, maker, swapVM, orderStruct, tokenA, tokenB, ether("100"), ether("200"));

      // Swap tokenB -> tokenA (isAToB = false)
      const takerData = TakerTraitsLib.build({
        taker: await taker.getAddress(),
        isExactIn: true,
        isAToB: false,
        threshold: ether("15"),
        useTransferFromAndAquaPush: true
      });

      const amountIn = ether("50");

      await tokenB.connect(taker).approve(await swapVM.getAddress(), amountIn);

      const tx = await swapVM.connect(taker).swap(
        orderStruct,
        amountIn,
        takerData
      );

      await expect(tx).to.changeTokenBalances(
        tokenB,
        [await taker.getAddress(), await maker.getAddress()],
        [-amountIn, amountIn]
      );
    });

    it("should not swap tokens after deadline", async function () {
      const {
        accounts: { maker, taker },
        tokens: { tokenA, tokenB },
        contracts: { aqua, aquaAMM, swapVM }
      } = await loadFixture(setupFixture);

      const deadline = await time.latest() + 86400;
      const orderStruct = await buildOrder(aquaAMM, maker, tokenA, tokenB, { salt: 1n, deadline });

      await shipLiquidity(aqua, maker, swapVM, orderStruct, tokenA, tokenB, ether("100"), ether("200"));

      const takerData = TakerTraitsLib.build({
        taker: await taker.getAddress(),
        isExactIn: true,
        isAToB: false,
        threshold: ether("15"),
        useTransferFromAndAquaPush: true
      });

      const amountIn = ether("50");

      await tokenB.connect(taker).approve(await swapVM.getAddress(), amountIn);

      await timeIncreaseTo(await time.latest() + 86401);
      await expect(swapVM.connect(taker).swap(
        orderStruct,
        amountIn,
        takerData
      )).to.be.revertedWithCustomError(aquaAMM, 'DeadlineReached');
    });
  });

  describe("Pegged Swap with AquaAMM", function () {
    it("should build, ship, and execute a pegged swap", async function () {
      const {
        accounts: { maker, taker },
        tokens: { tokenA, tokenB },
        contracts: { aqua, aquaAMM, swapVM }
      } = await loadFixture(setupFixture);

      const liquidityA = ether("100");
      const liquidityB = ether("100");
      const linearWidth = 8n * 10n ** 26n; // A = 0.8

      const built = await aquaAMM.buildPeggedProgram(
        await maker.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        0n, // feeBpsIn
        linearWidth,
        liquidityA,
        liquidityB,
        18,
        18,
        0n, // protocolFeeBpsIn
        constants.ZERO_ADDRESS,
        42n, // salt
        0n // deadline
      );
      const orderStruct = { maker: built.maker, traits: built.traits, data: built.data };

      await shipLiquidity(aqua, maker, swapVM, orderStruct, tokenA, tokenB, liquidityA, liquidityB);

      const amountIn = ether("10");
      const takerData = TakerTraitsLib.build({
        taker: await taker.getAddress(),
        isExactIn: true,
        isAToB: false,
        threshold: 1n,
        useTransferFromAndAquaPush: true
      });

      await tokenB.connect(taker).approve(await swapVM.getAddress(), amountIn);

      const tx = await swapVM.connect(taker).swap(orderStruct, amountIn, takerData);

      await expect(tx).to.changeTokenBalances(
        tokenB,
        [await taker.getAddress(), await maker.getAddress()],
        [-amountIn, amountIn]
      );
    });
  });
});
