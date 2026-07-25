// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1

// Copied from the official swap-vm template test helpers; hardhat's ethers swapped for plain
// ethers so the packing logic can run in the browser and in bun.
import { ethers, BigNumberish, BytesLike } from 'ethers';

interface MakerTraitsArgs {
  maker?: string;
  receiver?: string;
  tokenA: string;
  tokenB: string;
  shouldUnwrapWeth?: boolean;
  useAquaInsteadOfSignature?: boolean;
  allowZeroAmountIn?: boolean;
  hasPreTransferInHook?: boolean;
  hasPostTransferInHook?: boolean;
  hasPreTransferOutHook?: boolean;
  hasPostTransferOutHook?: boolean;
  preTransferInTarget?: string;
  preTransferInData?: BytesLike;
  postTransferInTarget?: string;
  postTransferInData?: BytesLike;
  preTransferOutTarget?: string;
  preTransferOutData?: BytesLike;
  postTransferOutTarget?: string;
  postTransferOutData?: BytesLike;
  program?: BytesLike;
}

interface TakerTraitsArgs {
  taker?: string;
  isExactIn?: boolean;
  isAToB?: boolean;
  shouldUnwrapWeth?: boolean;
  isStrictThresholdAmount?: boolean;
  isFirstTransferFromTaker?: boolean;
  useTransferFromAndAquaPush?: boolean;
  hasPreTransferInCallback?: boolean;
  hasPreTransferOutCallback?: boolean;
  threshold?: BytesLike | BigNumberish;
  to?: string;
  deadline?: BigNumberish;
  preTransferInHookData?: BytesLike;
  postTransferInHookData?: BytesLike;
  preTransferOutHookData?: BytesLike;
  postTransferOutHookData?: BytesLike;
  preTransferInCallbackData?: BytesLike;
  preTransferOutCallbackData?: BytesLike;
  instructionsArgs?: BytesLike;
  signature?: BytesLike;
}

class MakerTraitsLib {
  // Flag constants from MakerTraits.sol
  static readonly SHOULD_UNWRAP_BIT_FLAG = 1n << 255n;
  static readonly USE_AQUA_INSTEAD_OF_SIGNATURE_BIT_FLAG = 1n << 254n;
  static readonly ALLOW_ZERO_AMOUNT_IN = 1n << 253n;
  static readonly HAS_PRE_TRANSFER_IN_HOOK_BIT_FLAG = 1n << 252n;
  static readonly HAS_POST_TRANSFER_IN_HOOK_BIT_FLAG = 1n << 251n;
  static readonly HAS_PRE_TRANSFER_OUT_HOOK_BIT_FLAG = 1n << 250n;
  static readonly HAS_POST_TRANSFER_OUT_HOOK_BIT_FLAG = 1n << 249n;
  static readonly PRE_TRANSFER_IN_HOOK_HAS_TARGET = 1n << 248n;
  static readonly POST_TRANSFER_IN_HOOK_HAS_TARGET = 1n << 247n;
  static readonly PRE_TRANSFER_OUT_HOOK_HAS_TARGET = 1n << 246n;
  static readonly POST_TRANSFER_OUT_HOOK_HAS_TARGET = 1n << 245n;

  static readonly ORDER_DATA_SLICES_INDEXES_BIT_OFFSET = 160n;
  // Order data always starts with the 40-byte packed token pair (tokenA ++ tokenB)
  static readonly TOKENS_PREFIX_LENGTH = 40;

  static build(args: MakerTraitsArgs): { maker: string; traits: string; data: string } {
    // Convert inputs to bytes
    const toBytes = (data: BytesLike | undefined): Uint8Array => {
      if (!data) return new Uint8Array(0);
      const hex = ethers.hexlify(data);
      return ethers.getBytes(hex);
    };

    if (!args.tokenA || !args.tokenB) {
      throw new Error("MakerTraits: tokenA and tokenB are required");
    }
    if (BigInt(args.tokenA) >= BigInt(args.tokenB)) {
      throw new Error("MakerTraitsTokensNotSorted: tokenA must be strictly less than tokenB");
    }

    // Get all data sections as bytes
    const preTransferInDataBytes = toBytes(args.preTransferInData);
    const postTransferInDataBytes = toBytes(args.postTransferInData);
    const preTransferOutDataBytes = toBytes(args.preTransferOutData);
    const postTransferOutDataBytes = toBytes(args.postTransferOutData);
    const programBytes = toBytes(args.program);

    // Default values
    const maker = args.maker || ethers.ZeroAddress;
    const receiver = args.receiver || ethers.ZeroAddress;

    // Determine if targets should be included (non-zero and different from maker)
    const preTransferInHasTarget =
      args.preTransferInTarget &&
      args.preTransferInTarget !== ethers.ZeroAddress &&
      args.preTransferInTarget !== maker;
    const postTransferInHasTarget =
      args.postTransferInTarget &&
      args.postTransferInTarget !== ethers.ZeroAddress &&
      args.postTransferInTarget !== maker;
    const preTransferOutHasTarget =
      args.preTransferOutTarget &&
      args.preTransferOutTarget !== ethers.ZeroAddress &&
      args.preTransferOutTarget !== maker;
    const postTransferOutHasTarget =
      args.postTransferOutTarget &&
      args.postTransferOutTarget !== ethers.ZeroAddress &&
      args.postTransferOutTarget !== maker;

    // Validate hook data presence matches flags
    if ((preTransferInHasTarget || preTransferInDataBytes.length > 0) && !args.hasPreTransferInHook) {
      throw new Error("MakerTraitsMissingHasPreTransferInFlag: preTransferInData or target provided but hasPreTransferInHook is false");
    }
    if ((postTransferInHasTarget || postTransferInDataBytes.length > 0) && !args.hasPostTransferInHook) {
      throw new Error("MakerTraitsMissingHasPostTransferInFlag: postTransferInData or target provided but hasPostTransferInHook is false");
    }
    if ((preTransferOutHasTarget || preTransferOutDataBytes.length > 0) && !args.hasPreTransferOutHook) {
      throw new Error("MakerTraitsMissingHasPreTransferOutFlag: preTransferOutData or target provided but hasPreTransferOutHook is false");
    }
    if ((postTransferOutHasTarget || postTransferOutDataBytes.length > 0) && !args.hasPostTransferOutHook) {
      throw new Error("MakerTraitsMissingHasPostTransferOutFlag: postTransferOutData or target provided but hasPostTransferOutHook is false");
    }

    // Calculate slice indexes (cumulative byte positions, starting after the 40-byte token pair prefix)
    const index0 = this.TOKENS_PREFIX_LENGTH + (preTransferInHasTarget ? 20 : 0) + preTransferInDataBytes.length;
    const index1 = index0 + (postTransferInHasTarget ? 20 : 0) + postTransferInDataBytes.length;
    const index2 = index1 + (preTransferOutHasTarget ? 20 : 0) + preTransferOutDataBytes.length;
    const index3 = index2 + (postTransferOutHasTarget ? 20 : 0) + postTransferOutDataBytes.length;

    // Ensure indexes fit in uint16
    if (index0 > 0xFFFF || index1 > 0xFFFF || index2 > 0xFFFF || index3 > 0xFFFF) {
      throw new Error("MakerTraits: Data slice indexes exceed uint16 maximum");
    }

    // Pack slice indexes into 64 bits
    const orderDataIndexes =
      (BigInt(index0) << 0n) |
      (BigInt(index1) << 16n) |
      (BigInt(index2) << 32n) |
      (BigInt(index3) << 48n);

    // Build flags (as BigInt for 256-bit handling)
    let traits = 0n;
    if (args.shouldUnwrapWeth) traits |= this.SHOULD_UNWRAP_BIT_FLAG;
    if (args.useAquaInsteadOfSignature) traits |= this.USE_AQUA_INSTEAD_OF_SIGNATURE_BIT_FLAG;
    if (args.allowZeroAmountIn) traits |= this.ALLOW_ZERO_AMOUNT_IN;
    if (args.hasPreTransferInHook) traits |= this.HAS_PRE_TRANSFER_IN_HOOK_BIT_FLAG;
    if (args.hasPostTransferInHook) traits |= this.HAS_POST_TRANSFER_IN_HOOK_BIT_FLAG;
    if (args.hasPreTransferOutHook) traits |= this.HAS_PRE_TRANSFER_OUT_HOOK_BIT_FLAG;
    if (args.hasPostTransferOutHook) traits |= this.HAS_POST_TRANSFER_OUT_HOOK_BIT_FLAG;
    if (preTransferInHasTarget) traits |= this.PRE_TRANSFER_IN_HOOK_HAS_TARGET;
    if (postTransferInHasTarget) traits |= this.POST_TRANSFER_IN_HOOK_HAS_TARGET;
    if (preTransferOutHasTarget) traits |= this.PRE_TRANSFER_OUT_HOOK_HAS_TARGET;
    if (postTransferOutHasTarget) traits |= this.POST_TRANSFER_OUT_HOOK_HAS_TARGET;

    // Add orderDataIndexes at the correct position
    traits |= (orderDataIndexes << this.ORDER_DATA_SLICES_INDEXES_BIT_OFFSET);

    // Add receiver address (lower 160 bits)
    const receiverBigInt = BigInt(receiver);
    traits |= receiverBigInt;

    // Build data section: tokenA ++ tokenB ++ hooks ++ program
    const data = ethers.concat([
      ethers.zeroPadValue(args.tokenA, 20),
      ethers.zeroPadValue(args.tokenB, 20),
      preTransferInHasTarget ? ethers.zeroPadValue(args.preTransferInTarget!, 20) : new Uint8Array(0),
      preTransferInDataBytes,
      postTransferInHasTarget ? ethers.zeroPadValue(args.postTransferInTarget!, 20) : new Uint8Array(0),
      postTransferInDataBytes,
      preTransferOutHasTarget ? ethers.zeroPadValue(args.preTransferOutTarget!, 20) : new Uint8Array(0),
      preTransferOutDataBytes,
      postTransferOutHasTarget ? ethers.zeroPadValue(args.postTransferOutTarget!, 20) : new Uint8Array(0),
      postTransferOutDataBytes,
      programBytes
    ]);

    return {
      maker: maker,
      traits: ethers.zeroPadValue(ethers.toBeHex(traits), 32),
      data: ethers.hexlify(data)
    };
  }
}

// Helper class for building TakerTraits matching swap-vm implementation
class TakerTraitsLib {
  // Flag constants from TakerTraits.sol
  static readonly IS_EXACT_IN_BIT_FLAG = 0x0001;
  static readonly SHOULD_UNWRAP_BIT_FLAG = 0x0002;
  static readonly HAS_PRE_TRANSFER_IN_CALLBACK_BIT_FLAG = 0x0004;
  static readonly HAS_PRE_TRANSFER_OUT_CALLBACK_BIT_FLAG = 0x0008;
  static readonly IS_STRICT_THRESHOLD_BIT_FLAG = 0x0010;
  static readonly IS_FIRST_TRANSFER_FROM_TAKER_BIT_FLAG = 0x0020;
  static readonly USE_TRANSFER_FROM_AND_AQUA_PUSH_FLAG = 0x0040;
  static readonly IS_A_TO_B_BIT_FLAG = 0x0080;

  static build(args: TakerTraitsArgs): string {
    // Convert inputs to bytes
    const toBytes = (data: BytesLike | undefined): Uint8Array => {
      if (!data) return new Uint8Array(0);
      const hex = ethers.hexlify(data);
      return ethers.getBytes(hex);
    };

    // Special handling for threshold - convert BigNumberish to 32-byte value if needed
    let thresholdBytes: Uint8Array;
    if (!args.threshold) {
      thresholdBytes = new Uint8Array(0);
    } else if (typeof args.threshold === 'string' && args.threshold.startsWith('0x')) {
      // It's already hex bytes
      thresholdBytes = ethers.getBytes(args.threshold);
    } else {
      // It's a BigNumberish (number, bigint, or decimal string) - convert to 32 bytes
      thresholdBytes = ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(args.threshold), 32));
    }

    // Deadline is packed as 5 bytes (uint40) only when non-zero
    const deadline = BigInt(args.deadline ?? 0);
    if (deadline < 0n || deadline > 0xFFFFFFFFFFn) {
      throw new Error("TakerTraits: deadline must fit into uint40");
    }
    const deadlineBytes = deadline !== 0n
      ? ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(deadline), 5))
      : new Uint8Array(0);

    // Get all data sections as bytes
    const preTransferInHookBytes = toBytes(args.preTransferInHookData);
    const postTransferInHookBytes = toBytes(args.postTransferInHookData);
    const preTransferOutHookBytes = toBytes(args.preTransferOutHookData);
    const postTransferOutHookBytes = toBytes(args.postTransferOutHookData);
    const preTransferInCallbackBytes = toBytes(args.preTransferInCallbackData);
    const preTransferOutCallbackBytes = toBytes(args.preTransferOutCallbackData);
    const instructionsArgsBytes = toBytes(args.instructionsArgs);
    const signatureBytes = toBytes(args.signature);

    // Validate threshold length (must be 32 bytes or empty)
    if (thresholdBytes.length !== 0 && thresholdBytes.length !== 32) {
      throw new Error(`TakerTraitsThresholdLengthInvalid: threshold length must be 0 or 32 bytes, got ${thresholdBytes.length}`);
    }

    // Validate callback data presence matches flags
    if (preTransferInCallbackBytes.length > 0 && !args.hasPreTransferInCallback) {
      throw new Error("TakerTraitsMissingHasPreTransferInFlag: preTransferInCallbackData provided but hasPreTransferInCallback is false");
    }
    if (preTransferOutCallbackBytes.length > 0 && !args.hasPreTransferOutCallback) {
      throw new Error("TakerTraitsMissingHasPreTransferOutFlag: preTransferOutCallbackData provided but hasPreTransferOutCallback is false");
    }

    // Determine if 'to' address should be included
    const shouldIncludeTo = args.to && args.to !== ethers.ZeroAddress && args.to !== args.taker;
    const toAddressBytes = shouldIncludeTo ? ethers.getBytes(ethers.zeroPadValue(args.to!, 20)) : new Uint8Array(0);

    // Calculate slice indexes (cumulative byte positions)
    const index0 = thresholdBytes.length;
    const index1 = index0 + toAddressBytes.length;
    const index2 = index1 + deadlineBytes.length;
    const index3 = index2 + preTransferInHookBytes.length;
    const index4 = index3 + postTransferInHookBytes.length;
    const index5 = index4 + preTransferOutHookBytes.length;
    const index6 = index5 + postTransferOutHookBytes.length;
    const index7 = index6 + preTransferInCallbackBytes.length;
    const index8 = index7 + preTransferOutCallbackBytes.length;
    const index9 = index8 + instructionsArgsBytes.length;
    // Note: signature index is implicit (end of data)

    // Pack slice indexes into 160 bits (20 bytes)
    // Each index is 16 bits, index0 occupies the least significant bits
    const slicesIndexes = BigInt(index0) << 0n |
                          BigInt(index1) << 16n |
                          BigInt(index2) << 32n |
                          BigInt(index3) << 48n |
                          BigInt(index4) << 64n |
                          BigInt(index5) << 80n |
                          BigInt(index6) << 96n |
                          BigInt(index7) << 112n |
                          BigInt(index8) << 128n |
                          BigInt(index9) << 144n;

    // Build flags (16 bits)
    let flags = 0;
    if (args.isExactIn) flags |= this.IS_EXACT_IN_BIT_FLAG;
    if (args.shouldUnwrapWeth) flags |= this.SHOULD_UNWRAP_BIT_FLAG;
    if (args.isStrictThresholdAmount) flags |= this.IS_STRICT_THRESHOLD_BIT_FLAG;
    if (args.isFirstTransferFromTaker) flags |= this.IS_FIRST_TRANSFER_FROM_TAKER_BIT_FLAG;
    if (args.useTransferFromAndAquaPush) flags |= this.USE_TRANSFER_FROM_AND_AQUA_PUSH_FLAG;
    if (args.hasPreTransferInCallback) flags |= this.HAS_PRE_TRANSFER_IN_CALLBACK_BIT_FLAG;
    if (args.hasPreTransferOutCallback) flags |= this.HAS_PRE_TRANSFER_OUT_CALLBACK_BIT_FLAG;
    if (args.isAToB) flags |= this.IS_A_TO_B_BIT_FLAG;

    // Pack everything together
    const packed = ethers.concat([
      // First 20 bytes: slice indexes (160 bits)
      ethers.zeroPadValue(ethers.toBeHex(slicesIndexes), 20),
      // Next 2 bytes: flags (16 bits)
      ethers.zeroPadValue(ethers.toBeHex(flags), 2),
      // Then all the data sections in order
      thresholdBytes,
      toAddressBytes,
      deadlineBytes,
      preTransferInHookBytes,
      postTransferInHookBytes,
      preTransferOutHookBytes,
      postTransferOutHookBytes,
      preTransferInCallbackBytes,
      preTransferOutCallbackBytes,
      instructionsArgsBytes,
      signatureBytes
    ]);

    return ethers.hexlify(packed);
  }
}

// Opcode indices from AquaOpcodes.sol (_runOpcode dispatch table)
const AquaOpcodes = {
  // 0x00-0x09 - reserved for debugging utilities

  // Controls - control flow
  JUMP: 0x0A,                                      // Controls._jump
  JUMP_IF_TOKEN_IN: 0x0B,                          // Controls._jumpIfTokenIn
  JUMP_IF_TOKEN_OUT: 0x0C,                         // Controls._jumpIfTokenOut
  DEADLINE: 0x0D,                                  // Controls._deadline
  ONLY_TAKER_TOKEN_BALANCE_NON_ZERO: 0x0E,         // Controls._onlyTakerTokenBalanceNonZero
  ONLY_TAKER_TOKEN_BALANCE_GTE: 0x0F,              // Controls._onlyTakerTokenBalanceGte
  ONLY_TAKER_TOKEN_SUPPLY_SHARE_GTE: 0x10,         // Controls._onlyTakerTokenSupplyShareGte

  // XYCSwap - basic swap
  XYC_SWAP_XD: 0x11,                               // XYCSwap._xycSwapXD

  // XYCConcentrate - liquidity concentration
  XYC_CONCENTRATE_GROW_LIQUIDITY_2D: 0x12,         // XYCConcentrate._xycConcentrateGrowLiquidity2D

  // Decay - Decay AMM
  DECAY_XD: 0x13,                                  // Decay._decayXD

  // Additional instructions
  SALT: 0x14,                                      // Controls._salt
  FLAT_FEE_AMOUNT_IN_XD: 0x15,                     // Fee._flatFeeAmountInXD
  // 0x16-0x1A - reserved
  PROTOCOL_FEE_AMOUNT_IN_XD: 0x1B,                 // Fee._protocolFeeAmountInXD
  AQUA_PROTOCOL_FEE_AMOUNT_IN_XD: 0x1C,            // Fee._aquaProtocolFeeAmountInXD
  DYNAMIC_PROTOCOL_FEE_AMOUNT_IN_XD: 0x1D,         // Fee._dynamicProtocolFeeAmountInXD
  AQUA_DYNAMIC_PROTOCOL_FEE_AMOUNT_IN_XD: 0x1E,    // Fee._aquaDynamicProtocolFeeAmountInXD
  PEGGED_SWAP_GROW_PRICE_RANGE_2D: 0x1F,           // PeggedSwap._peggedSwapGrowPriceRange2D
  EXTRUCTION: 0x20,                                // Extruction._extruction
  ONLY_TX_ORIGIN_TOKEN_BALANCE_NON_ZERO: 0x21      // Controls._onlyTxOriginTokenBalanceNonZero
};

// Opcode indices from Opcodes.sol (_runOpcode dispatch table)
const Opcodes = {
  // 0x00-0x09 - reserved for debugging utilities

  // Controls - control flow
  JUMP: 0x0A,                                      // Controls._jump
  JUMP_IF_TOKEN_IN: 0x0B,                          // Controls._jumpIfTokenIn
  JUMP_IF_TOKEN_OUT: 0x0C,                         // Controls._jumpIfTokenOut
  DEADLINE: 0x0D,                                  // Controls._deadline
  ONLY_TAKER_TOKEN_BALANCE_NON_ZERO: 0x0E,         // Controls._onlyTakerTokenBalanceNonZero
  ONLY_TAKER_TOKEN_BALANCE_GTE: 0x0F,              // Controls._onlyTakerTokenBalanceGte
  ONLY_TAKER_TOKEN_SUPPLY_SHARE_GTE: 0x10,         // Controls._onlyTakerTokenSupplyShareGte

  // Balances - balance operations
  STATIC_BALANCES_XD: 0x11,                        // Balances._staticBalancesXD
  DYNAMIC_BALANCES_XD: 0x12,                       // Balances._dynamicBalancesXD

  // Invalidators - order invalidation
  INVALIDATORS_INVALIDATE_BIT_1D: 0x13,            // Invalidators._invalidateBit1D
  INVALIDATORS_INVALIDATE_TOKEN_IN_1D: 0x14,       // Invalidators._invalidateTokenIn1D
  INVALIDATORS_INVALIDATE_TOKEN_OUT_1D: 0x15,      // Invalidators._invalidateTokenOut1D

  // XYCSwap - basic swap
  XYC_SWAP_XD: 0x16,                               // XYCSwap._xycSwapXD

  // XYCConcentrate - liquidity concentration
  XYC_CONCENTRATE_GROW_LIQUIDITY_2D: 0x17,         // XYCConcentrate._xycConcentrateGrowLiquidity2D

  // Decay - Decay AMM
  DECAY_XD: 0x18,                                  // Decay._decayXD

  // LimitSwap - limit orders
  LIMIT_SWAP_1D: 0x19,                             // LimitSwap._limitSwap1D
  LIMIT_SWAP_ONLY_FULL_1D: 0x1A,                   // LimitSwap._limitSwapOnlyFull1D

  // MinRate - minimum exchange rate enforcement
  REQUIRE_MIN_RATE_1D: 0x1B,                       // MinRate._requireMinRate1D
  ADJUST_MIN_RATE_1D: 0x1C,                        // MinRate._adjustMinRate1D

  // DutchAuction - auction mechanism
  DUTCH_AUCTION_BALANCE_IN_1D: 0x1D,               // DutchAuction._dutchAuctionBalanceIn1D
  DUTCH_AUCTION_BALANCE_OUT_1D: 0x1E,              // DutchAuction._dutchAuctionBalanceOut1D

  // BaseFeeAdjuster - gas-based price adjustment
  BASE_FEE_ADJUSTER_1D: 0x1F,                      // BaseFeeAdjuster._baseFeeAdjuster1D

  // TWAPSwap - TWAP trading
  TWAP: 0x20,                                      // TWAPSwap._twap

  // Additional instructions
  EXTRUCTION: 0x21,                                // Extruction._extruction
  SALT: 0x22,                                      // Controls._salt
  FLAT_FEE_AMOUNT_IN_XD: 0x23,                     // Fee._flatFeeAmountInXD
  FLAT_FEE_AMOUNT_OUT_XD: 0x24,                    // FeeExperimental._flatFeeAmountOutXD
  PROGRESSIVE_FEE_IN_XD: 0x25,                     // FeeExperimental._progressiveFeeInXD
  PROGRESSIVE_FEE_OUT_XD: 0x26,                    // FeeExperimental._progressiveFeeOutXD
  PROTOCOL_FEE_AMOUNT_OUT_XD: 0x27,                // FeeExperimental._protocolFeeAmountOutXD
  AQUA_PROTOCOL_FEE_AMOUNT_OUT_XD: 0x28,           // FeeExperimental._aquaProtocolFeeAmountOutXD
  PEGGED_SWAP_GROW_PRICE_RANGE_2D: 0x29,           // PeggedSwap._peggedSwapGrowPriceRange2D
  PROTOCOL_FEE_AMOUNT_IN_XD: 0x2A,                 // Fee._protocolFeeAmountInXD
  AQUA_PROTOCOL_FEE_AMOUNT_IN_XD: 0x2B,            // Fee._aquaProtocolFeeAmountInXD
  DYNAMIC_PROTOCOL_FEE_AMOUNT_IN_XD: 0x2C,         // Fee._dynamicProtocolFeeAmountInXD
  AQUA_DYNAMIC_PROTOCOL_FEE_AMOUNT_IN_XD: 0x2D,    // Fee._aquaDynamicProtocolFeeAmountInXD
  VALIDATE_SERIES_EPOCH_XD: 0x2E,                  // SeriesEpochManager._validateSeriesEpochXD
  WHITELIST_SINGLE_TAKER: 0x2F,                    // Whitelist._whitelistSingleTaker
  WHITELIST_MULTIPLE_TAKERS: 0x30,                 // Whitelist._whitelistMultipleTakers
  PIECEWISE_LINEAR_SCALE_BALANCE_IN_1D: 0x31,      // PiecewiseLinearScale._piecewiseLinearScaleBalanceIn1D
  PIECEWISE_LINEAR_SCALE_BALANCE_OUT_1D: 0x32,     // PiecewiseLinearScale._piecewiseLinearScaleBalanceOut1D
  ONLY_TX_ORIGIN_TOKEN_BALANCE_NON_ZERO: 0x33      // Controls._onlyTxOriginTokenBalanceNonZero
};

export {
  TakerTraitsLib,
  TakerTraitsArgs,
  MakerTraitsLib,
  MakerTraitsArgs,
  AquaOpcodes,
  Opcodes
};
