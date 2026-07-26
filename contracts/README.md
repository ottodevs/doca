# Doca: contracts

Doca's on-chain half, built on [1inch's SwapVM and Aqua protocol](https://1inch.com/aqua). This
directory started as the official `swap-vm-template` scaffold; the Prerequisites, Installation and
Deployment sections below still describe that scaffold and apply as-is. Doca's own contracts sit on
top of it.

## Overview

- **`InventorySkewProvider`** (`contracts/InventorySkewProvider.sol`): the on-chain half of Doca's
  budget invariant. An `IProtocolFeeProvider` plugged into SwapVM's stock
  `AquaDynamicProtocolFeeAmountIn` opcode: it prices inventory depletion per strategy, flat while a
  budget is healthy and rising quadratically as it drains.
- **`DocaApp`** (`contracts/DocaApp.sol`): builds the Aqua-backed SwapVM program for a strategy,
  wiring the skew provider into the fee instruction ahead of the concentrated-liquidity curve.
- **`AquaAMM`**: the official `swap-vm-template` concentrated-liquidity AMM strategy, kept
  unmodified and used as the paired control in the measurement scripts.
- **`MockTaker`**: a test contract for simulating swap operations.
- **Deployment scripts** and **test suite**: covering both the template's own AquaAMM tests and
  Doca's `InventorySkewProvider`/`DocaApp` tests.

## Prerequisites

- Node.js v18+ (Note: Node.js v23 may show warnings but works)
- Yarn
- Git

## Installation

1. Clone the repository:
```bash
git clone https://github.com/1inch/swap-vm-template.git
cd swap-vm-template
```

2. Install dependencies:
```bash
yarn
```

3. Copy environment variables:
```bash
cp .env.example .env
```

4. Configure your `.env` file:
```
PRIVATE_KEY=your_private_key_here
SEPOLIA_RPC_URL=your_sepolia_rpc_url
ETHERSCAN_API_KEY=your_etherscan_api_key
```

## Compilation

Compile the smart contracts:
```bash
npx hardhat compile
```

## Testing

Run the test suite:
```bash
npx hardhat test
```

## Deployment

### Local Deployment

Deploy to local Hardhat network:
```bash
yarn deploy hardhat
```

### Testnet Deployment

Deploy to Sepolia testnet:
```bash
yarn deploy sepolia
```

The deployment script will:
1. Deploy Aqua protocol
2. Deploy AquaAMM strategy
3. Resolve WETH (deploys a WETHMock on local networks; uses the canonical address or `WETH_ADDRESS` env on live networks)
4. Deploy AquaSwapVMRouter
5. Deploy MockTaker (optional, for testing)
6. Verify all contracts on Etherscan (for non-local networks)

## Usage Examples

### Creating an AMM Order

```typescript
const order = await aquaAMM.buildProgram(
  makerAddress,        // Liquidity provider
  tokenAAddress,       // First token of the pair (sorted automatically)
  tokenBAddress,       // Second token of the pair (sorted automatically)
  feeBpsIn,            // Trading fee on input amount in bps (1e9 = 100%)
  sqrtPriceMin,        // sqrt(P_min) in 1e18 fixed-point (0 = full range)
  sqrtPriceMax,        // sqrt(P_max) in 1e18 fixed-point (0 = full range)
  decayPeriod,         // Price decay period in seconds
  protocolFeeBpsIn,    // Protocol fee on input amount in bps (1e9 = 100%)
  feeReceiverAddress,  // Protocol fee receiver address
  salt,                // Unique order identifier
  deadline             // Order expiration timestamp (0 = no deadline)
);
```

### Executing a Swap

The token pair is embedded in the order (`tokenA` < `tokenB` by address); the taker
selects the swap direction with the `isAToB` flag:

```typescript
// Build taker traits
const takerData = TakerTraitsLib.build({
  taker: takerAddress,
  isExactIn: true,
  isAToB: true,               // true: tokenA -> tokenB, false: tokenB -> tokenA
  threshold: minOutputAmount,
  useTransferFromAndAquaPush: true
});

// Execute swap
await swapVM.swap(
  order,
  amountIn,
  takerData
);
```

## Development

### Project Structure

```
swap-vm-template/
├── contracts/           # Smart contracts
│   ├── AquaAMM.sol     # AMM strategy implementation
│   ├── MockTaker.sol   # Test resolver contract
│   └── SwapVMImport.sol # SwapVM imports
├── deploy/             # Deployment scripts
├── test/               # Test suite
│   ├── AquaAMM.test.ts # Main test file
│   └── utils/          # Test utilities
├── typechain-types/    # Generated TypeScript types
└── hardhat.config.ts   # Hardhat configuration
```

### Building Custom Strategies

To create your own swap strategy:

1. Create a new contract inheriting from SwapVM opcodes
2. Implement your swap logic using the VM instruction set
3. Build program bytecode using the ProgramBuilder
4. Deploy and register with Aqua

### Testing Your Strategy

1. Write unit tests for your strategy logic
2. Test with both resolver contracts and EOAs
3. Verify gas consumption and optimization
4. Test edge cases and error conditions

## Resources


## Disclaimer

This software is provided "as is", without warranty of any kind. Use at your own risk.

## 📄 License

This project is licensed under the **LicenseRef-Degensoft-SwapVM-1.1**

See the [LICENSE](LICENSE) file for details.
See the [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) file for information about third-party software, libraries, and dependencies used in this project.

**Contact for licensing inquiries:**
- 📧 license@degensoft.com 
- 📧 legal@degensoft.com
