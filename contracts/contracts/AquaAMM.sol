// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm-template/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd

import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { ProgramBuilder, Program } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { DecayArgsBuilder } from "@1inch/swap-vm/src/instructions/Decay.sol";
import { XYCConcentrateArgsBuilder } from "@1inch/swap-vm/src/instructions/XYCConcentrate.sol";
import { PeggedSwapArgsBuilder } from "@1inch/swap-vm/src/instructions/PeggedSwap.sol";
import { FeeArgsBuilder } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";

contract AquaAMM is AquaOpcodes {
    using ProgramBuilder for Program;

    error ProtocolFeesExceedMakerFees(uint256 protocolFeeBps, uint256 makerFeeBps);
    error ZeroReserve();

    constructor(address aqua) AquaOpcodes(aqua) {}

    /// @dev Rate that scales `tokenDecimals` up to the higher of the two decimal places.
    function _peggedRate(uint8 tokenDecimals, uint8 otherDecimals) private pure returns (uint256) {
        if (tokenDecimals >= otherDecimals) return 1;
        return 10 ** uint256(otherDecimals - tokenDecimals);
    }

    /// @notice Builds an AMM order for the given token pair
    /// @param maker Liquidity provider address
    /// @param tokenA First token of the pair (sorted automatically if needed)
    /// @param tokenB Second token of the pair (sorted automatically if needed)
    /// @param feeBpsIn Trading fee on input amount in bps (1e9 = 100%)
    /// @param sqrtPriceMin sqrt(P_min) in 1e18 fixed-point, where P = tokenGt/tokenLt (0 = full range)
    /// @param sqrtPriceMax sqrt(P_max) in 1e18 fixed-point, where P = tokenGt/tokenLt (0 = full range)
    /// @param decayPeriod Price decay period in seconds (0 = no decay)
    /// @param protocolFeeBpsIn Protocol fee on input amount in bps (1e9 = 100%)
    /// @param feeReceiver Protocol fee receiver address
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
        uint32 protocolFeeBpsIn,
        address feeReceiver,
        uint64 salt,
        uint40 deadline
    ) external pure returns (ISwapVM.Order memory) {
        require(protocolFeeBpsIn <= feeBpsIn, ProtocolFeesExceedMakerFees(protocolFeeBpsIn, feeBpsIn));
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        Program memory program = ProgramBuilder.init(_opcodes());
        bool isConcentrated = sqrtPriceMin != 0 || sqrtPriceMax != 0;
        bytes memory bytecode = bytes.concat(
            (deadline > 0) ? program.build(_deadline, ControlsArgsBuilder.buildDeadline(deadline)) : bytes(""),
            (protocolFeeBpsIn > 0) ? program.build(_aquaProtocolFeeAmountInXD, FeeArgsBuilder.buildProtocolFee(protocolFeeBpsIn, feeReceiver)) : bytes(""),
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

    /// @notice Builds a pegged-curve AMM order for the given token pair
    /// @param maker Liquidity provider address
    /// @param tokenA First token of the pair (sorted automatically if needed)
    /// @param tokenB Second token of the pair (sorted automatically if needed)
    /// @param feeBpsIn Trading fee on input amount in bps (1e9 = 100%)
    /// @param linearWidth PeggedSwap A parameter scaled by 1e27 (e.g. 0.8e27)
    /// @param reserveA Initial reserve for tokenA (raw units; used as PeggedSwap x0/y0 with rates)
    /// @param reserveB Initial reserve for tokenB (raw units)
    /// @param decimalsA Decimals of tokenA
    /// @param decimalsB Decimals of tokenB
    /// @param protocolFeeBpsIn Protocol fee on input amount in bps (1e9 = 100%)
    /// @param feeReceiver Protocol fee receiver address
    /// @param salt Unique order identifier (0 = no salt)
    /// @param deadline Order expiration timestamp (0 = no deadline)
    function buildPeggedProgram(
        address maker,
        address tokenA,
        address tokenB,
        uint32 feeBpsIn,
        uint256 linearWidth,
        uint256 reserveA,
        uint256 reserveB,
        uint8 decimalsA,
        uint8 decimalsB,
        uint32 protocolFeeBpsIn,
        address feeReceiver,
        uint64 salt,
        uint40 deadline
    ) external pure returns (ISwapVM.Order memory) {
        require(protocolFeeBpsIn <= feeBpsIn, ProtocolFeesExceedMakerFees(protocolFeeBpsIn, feeBpsIn));
        require(reserveA > 0 && reserveB > 0, ZeroReserve());

        uint256 rateA = _peggedRate(decimalsA, decimalsB);
        uint256 rateB = _peggedRate(decimalsB, decimalsA);

        uint256 x0;
        uint256 y0;
        uint256 rateLt;
        uint256 rateGt;
        if (tokenA < tokenB) {
            x0 = reserveA * rateA;
            y0 = reserveB * rateB;
            rateLt = rateA;
            rateGt = rateB;
        } else {
            x0 = reserveB * rateB;
            y0 = reserveA * rateA;
            rateLt = rateB;
            rateGt = rateA;
            (tokenA, tokenB) = (tokenB, tokenA);
        }

        Program memory program = ProgramBuilder.init(_opcodes());
        bytes memory bytecode = bytes.concat(
            (deadline > 0) ? program.build(_deadline, ControlsArgsBuilder.buildDeadline(deadline)) : bytes(""),
            (protocolFeeBpsIn > 0) ? program.build(_aquaProtocolFeeAmountInXD, FeeArgsBuilder.buildProtocolFee(protocolFeeBpsIn, feeReceiver)) : bytes(""),
            (feeBpsIn > 0) ? program.build(_flatFeeAmountInXD, FeeArgsBuilder.buildFlatFee(feeBpsIn)) : bytes(""),
            program.build(
                _peggedSwapGrowPriceRange2D,
                PeggedSwapArgsBuilder.build(PeggedSwapArgsBuilder.Args({
                    x0: x0,
                    y0: y0,
                    linearWidth: linearWidth,
                    rateLt: rateLt,
                    rateGt: rateGt
                }))
            ),
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
