// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IProtocolFeeProvider } from "@1inch/swap-vm/src/instructions/interfaces/IProtocolFeeProvider.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

/// @title InventorySkewProvider
/// @notice Prices inventory depletion for a shared-liquidity Aqua strategy.
/// @dev Aqua lets one wallet balance back many strategies at once, so the same tokens can be sold
/// through several programs concurrently. The failure mode is inventory: once one leg of a strategy
/// drains toward zero, takers stop being fillable and the maker's next refill is arbitraged at a
/// stale price. This contract is the load line for that: it is plugged into SwapVM's stock
/// `AquaDynamicProtocolFeeAmountIn` instruction (opcode 30) and returns a fee that is flat while
/// inventory is healthy and rises convexly as the outgoing leg approaches its waterline.
///
/// Two properties matter:
/// 1. It is directional. The fee is a function of the *outgoing* token only, so draining the scarce
///    leg gets progressively more expensive while trading in the replenishing direction stays at the
///    base rate. Takers are paid, in price, to rebalance the maker.
/// 2. The surcharge leaves the shared pool. SwapVM pulls the fee from the maker's Aqua balance and
///    forwards it to `harvestTo`, so the extra revenue is withdrawn from shared liquidity exactly
///    when oversubscription risk is highest, instead of being re-committed to the position.
///
/// Pricing reads Aqua's virtual balances only, never the maker's real wallet balance or allowances,
/// which is the invariant the SwapVM design notes require of any pricing input.
contract InventorySkewProvider is IProtocolFeeProvider {
    /// @dev SwapVM fee denominator: 1e9 == 100%.
    uint256 private constant _BPS = 1e9;
    /// @dev Inventory fractions are expressed against this scale: 1e4 == fully stocked.
    uint256 private constant _FRAC = 1e4;

    error NotMaker();
    error InvalidCurve();
    error ZeroReference();

    /// @param maker Liquidity provider that shipped the strategy
    /// @param token0 First token of the pair
    /// @param token1 Second token of the pair
    /// @param reference0 Virtual balance of token0 promised at ship time, used to measure consumption
    /// @param reference1 Virtual balance of token1 promised at ship time
    /// @param budget0 How much token0 this strategy may consume before the waterline (0 = reference0)
    /// @param budget1 How much token1 this strategy may consume before the waterline (0 = reference1)
    /// @param baseFeeBps Fee charged while the budget is largely unspent
    /// @param maxFeeBps Fee charged once the budget is exhausted
    /// @param kink Remaining budget fraction (of 1e4) where the ramp starts
    /// @param waterlineFrac Remaining budget fraction (of 1e4) where maxFeeBps is reached
    /// @param harvestTo Recipient of the depletion surcharge, normally the maker's own wallet
    struct Waterline {
        address maker;
        address token0;
        address token1;
        uint128 reference0;
        uint128 reference1;
        uint128 budget0;
        uint128 budget1;
        uint32 baseFeeBps;
        uint32 maxFeeBps;
        uint16 kink;
        uint16 waterlineFrac;
        address harvestTo;
    }

    IAqua public immutable AQUA;
    /// @notice The Aqua app these strategies settle through, i.e. the AquaSwapVMRouter.
    address public immutable APP;

    mapping(bytes32 orderHash => Waterline) private _waterlines;

    event WaterlineSet(
        bytes32 indexed orderHash,
        address indexed maker,
        uint32 baseFeeBps,
        uint32 maxFeeBps,
        uint16 kink,
        uint16 waterlineFrac
    );

    constructor(IAqua aqua, address app) {
        AQUA = aqua;
        APP = app;
    }

    /// @notice Registers the depletion curve for a strategy. Called by the maker after `ship`.
    /// @dev The references cannot be read back from Aqua after trading starts, so the maker records
    /// them here. Re-registering re-parameterizes the curve, which mirrors Aqua's own dock/ship
    /// re-parameterization model.
    function setWaterline(bytes32 orderHash, Waterline calldata w) external {
        if (msg.sender != w.maker) revert NotMaker();
        if (w.reference0 == 0 || w.reference1 == 0) revert ZeroReference();
        if (w.harvestTo == address(0)) revert InvalidCurve();
        if (w.maxFeeBps < w.baseFeeBps || w.maxFeeBps > _BPS) revert InvalidCurve();
        if (w.kink > _FRAC || w.waterlineFrac > w.kink) revert InvalidCurve();
        if (w.budget0 > w.reference0 || w.budget1 > w.reference1) revert InvalidCurve();

        _waterlines[orderHash] = w;
        emit WaterlineSet(orderHash, w.maker, w.baseFeeBps, w.maxFeeBps, w.kink, w.waterlineFrac);
    }

    function waterlineOf(bytes32 orderHash) external view returns (Waterline memory) {
        return _waterlines[orderHash];
    }

    /// @notice Remaining inventory of `token` in this strategy, as a fraction of 1e4 of its reference.
    /// @dev 1e4 means fully stocked or better, 0 means drained. Unknown tokens read as fully stocked
    /// so that a misregistration can never inflate the fee.
    function remainingFraction(bytes32 orderHash, address token) public view returns (uint256) {
        Waterline memory w = _waterlines[orderHash];
        return _remainingFraction(w, orderHash, token);
    }

    /// @notice The fee this provider would quote for draining `tokenOut` right now, in bps of 1e9.
    function feeBpsFor(bytes32 orderHash, address tokenOut) public view returns (uint32) {
        Waterline memory w = _waterlines[orderHash];
        if (w.maker == address(0)) return 0;
        return _feeBps(w, orderHash, tokenOut);
    }

    /// @inheritdoc IProtocolFeeProvider
    /// @dev Only `orderHash`, `maker` and `tokenOut` are used. The fee is deliberately independent of
    /// the taker and of the swap amounts, so quote and swap cannot diverge and the instruction stays a
    /// pure function of committed inventory.
    function getFeeBpsAndRecipient(
        bytes32 orderHash,
        address maker,
        address /* taker */,
        address /* tokenIn */,
        address tokenOut,
        bool /* isExactIn */
    ) external view returns (uint32, address) {
        Waterline memory w = _waterlines[orderHash];
        if (w.maker != maker) return (0, address(0));
        return (_feeBps(w, orderHash, tokenOut), w.harvestTo);
    }

    function _remainingFraction(
        Waterline memory w,
        bytes32 orderHash,
        address token
    ) private view returns (uint256) {
        uint256 shipped;
        uint256 budget;
        if (token == w.token0) {
            shipped = w.reference0;
            budget = w.budget0 == 0 ? shipped : w.budget0;
        } else if (token == w.token1) {
            shipped = w.reference1;
            budget = w.budget1 == 0 ? shipped : w.budget1;
        } else {
            return _FRAC;
        }

        (uint248 balance, ) = AQUA.rawBalances(w.maker, APP, orderHash, token);
        if (balance >= shipped) return _FRAC;

        // A promise may exceed the wallet, which is the point of Aqua. A budget may not: the maker
        // sizes each strategy's budget so the budgets sum to what is actually held, which is what
        // keeps every promise honorable. Depletion is therefore measured as budget consumed, not as
        // balance remaining.
        uint256 consumed = shipped - balance;
        if (consumed >= budget) return 0;
        return ((budget - consumed) * _FRAC) / budget;
    }

    /// @dev Convex ramp: flat above the kink, quadratic between kink and waterline, capped below it.
    /// Quadratic rather than linear so that ordinary flow is untouched and the surcharge only bites
    /// once the position is genuinely close to being unfillable.
    function _feeBps(Waterline memory w, bytes32 orderHash, address tokenOut) private view returns (uint32) {
        uint256 remaining = _remainingFraction(w, orderHash, tokenOut);
        if (remaining >= w.kink) return w.baseFeeBps;
        if (remaining <= w.waterlineFrac) return w.maxFeeBps;

        uint256 span = uint256(w.kink) - uint256(w.waterlineFrac);
        uint256 travelled = uint256(w.kink) - remaining;
        uint256 spread = uint256(w.maxFeeBps) - uint256(w.baseFeeBps);

        return uint32(uint256(w.baseFeeBps) + (spread * travelled * travelled) / (span * span));
    }
}
