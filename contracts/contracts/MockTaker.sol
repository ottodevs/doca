// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm-template/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/src/interfaces/ITakerCallbacks.sol";

contract MockTaker is ITakerCallbacks, Ownable {
    IAqua public immutable aqua;
    ISwapVM public immutable swapVM;

    modifier onlySwapVM() {
        require(msg.sender == address(swapVM), "Not the SwapVM");
        _;
    }

    constructor(address aqua_, address swapVM_, address owner_) Ownable(owner_) {
        aqua = IAqua(aqua_);
        swapVM = ISwapVM(swapVM_);
    }

    function swap(
        ISwapVM.Order calldata order,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external onlyOwner returns (uint256 amountIn, uint256 amountOut) {
        (amountIn, amountOut,) = swapVM.swap(
            order,
            amount,
            takerTraitsAndData
        );
    }

    function preTransferInCallback(
        address maker,
        address /* taker */,
        address tokenIn,
        address /* tokenOut */,
        uint256 amountIn,
        uint256 /* amountOut */,
        bytes32 orderHash,
        bytes calldata /* takerData */
    ) external override onlySwapVM {
        IERC20(tokenIn).approve(address(aqua), amountIn);
        aqua.push(maker, address(swapVM), orderHash, tokenIn, amountIn);
    }

    function preTransferOutCallback(
        address /* maker */,
        address /* taker */,
        address /* tokenIn */,
        address /* tokenOut */,
        uint256 /* amountIn */,
        uint256 /* amountOut */,
        bytes32 /* orderHash */,
        bytes calldata /* takerData */
    ) external override onlySwapVM {
        // Custom exchange rate validation can be implemented here
    }
}
