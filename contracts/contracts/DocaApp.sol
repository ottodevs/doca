// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm-template/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd
/// @dev Derived from the official swap-vm-template AquaAMM example. The only structural change is
/// the dynamic protocol fee instruction, which points at an InventorySkewProvider instead of a
/// static fee, so the program's spread becomes a function of committed inventory.

import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { ProgramBuilder, Program } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { DecayArgsBuilder } from "@1inch/swap-vm/src/instructions/Decay.sol";
import { XYCConcentrateArgsBuilder } from "@1inch/swap-vm/src/instructions/XYCConcentrate.sol";
import { FeeArgsBuilder } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";

/// @title DocaApp
/// @notice Builds Aqua-backed SwapVM programs whose spread widens as inventory drains.
contract DocaApp is AquaOpcodes {
    using ProgramBuilder for Program;

    constructor(address aqua) AquaOpcodes(aqua) {}

    /// @notice Builds an inventory-aware order for the given token pair
    /// @param maker Liquidity provider address
    /// @param tokenA First token of the pair (sorted automatically if needed)
    /// @param tokenB Second token of the pair (sorted automatically if needed)
    /// @param feeBpsIn Flat trading fee on input amount in bps (1e9 = 100%), 0 = none
    /// @param sqrtPriceMin sqrt(P_min) in 1e18 fixed-point, where P = tokenGt/tokenLt (0 = full range)
    /// @param sqrtPriceMax sqrt(P_max) in 1e18 fixed-point (0 = full range)
    /// @param decayPeriod Price decay period in seconds (0 = no decay)
    /// @param skewProvider InventorySkewProvider address (0 = no inventory skew, plain program)
    /// @param salt Unique order identifier (0 = no salt)
    /// @param deadline Order expiration timestamp (0 = no deadline)
    function buildProgram(
        address maker,
        address tokenA,
        address tokenB,
        uint32 feeBpsIn,
        uint256 sqrtPriceMin,
        uint256 sqrtPriceMax,
        uint16 decayPeriod,
        address skewProvider,
        uint64 salt,
        uint40 deadline
    ) external pure returns (ISwapVM.Order memory) {
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        Program memory program = ProgramBuilder.init(_opcodes());
        bool isConcentrated = sqrtPriceMin != 0 || sqrtPriceMax != 0;

        // Instruction order is security-critical in SwapVM. Fees run before the curve so the skew is
        // applied to the amount the curve prices, and the salt closes the program.
        bytes memory bytecode = bytes.concat(
            (deadline > 0) ? program.build(_deadline, ControlsArgsBuilder.buildDeadline(deadline)) : bytes(""),
            (skewProvider != address(0))
                ? program.build(_aquaDynamicProtocolFeeAmountInXD, FeeArgsBuilder.buildDynamicProtocolFee(skewProvider))
                : bytes(""),
            (feeBpsIn > 0) ? program.build(_flatFeeAmountInXD, FeeArgsBuilder.buildFlatFee(feeBpsIn)) : bytes(""),
            (decayPeriod > 0) ? program.build(_decayXD, DecayArgsBuilder.build(decayPeriod)) : bytes(""),
            isConcentrated
                ? program.build(_xycConcentrateGrowLiquidity2D, XYCConcentrateArgsBuilder.build2D(sqrtPriceMin, sqrtPriceMax))
                : program.build(_xycSwapXD),
            (salt > 0) ? program.build(_salt, ControlsArgsBuilder.buildSalt(salt)) : bytes("")
        );

        return MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker,
            receiver: address(0),
            tokenA: tokenA,
            tokenB: tokenB,
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: bytecode
        }));
    }
}
