import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import 'hardhat-deploy';
import 'hardhat-tracer';
import "@typechain/hardhat";
import 'hardhat-dependency-compiler';
import { HardhatUserConfig } from 'hardhat/config';

dotenv.config();

const config: HardhatUserConfig = {
  networks: {
    // FORK_BASE=1 runs against a fork of Base, where the canonical Aqua and SwapVM are live, so
    // scripts exercise 1inch's real deployed contracts and real tokens without spending anything.
    // Off by default so the unit tests stay fast and offline.
    hardhat: process.env.FORK_BASE
      ? {
          forking: {
            url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
            blockNumber: process.env.BASE_FORK_BLOCK ? Number(process.env.BASE_FORK_BLOCK) : undefined,
          },
          chainId: 8453,
          hardfork: "cancun",
          // Hardhat has no built-in hardfork history for Base, so calls at forked blocks fail
          // with "No known hardfork for execution on historical block" until this is declared.
          chains: {
            8453: { hardforkHistory: { cancun: 0 } },
          },
        }
      : {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: process.env.PRIVATE_KEY ? ["0x" + process.env.PRIVATE_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? ["0x" + process.env.PRIVATE_KEY] : [],
    },
    // Add your deployment network here and the corresponding URL in the .env file
  },
  namedAccounts: {
    deployer: {
      default: 0, // here this will by default take the first account as deployer
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
            details: {
              yul: true,
              yulDetails: {
                stackAllocation: true,
                optimizerSteps: "dhfoDgvulfnTUtnIf"
              }
            }
          },
          evmVersion: "cancun",
          viaIR: true
        }
      }
    ],
  },
  dependencyCompiler: {
    paths: [
      "@1inch/aqua/src/Aqua.sol",
      "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol",
      "@1inch/swap-vm/src/routers/SwapVMRouter.sol",
      "@1inch/swap-vm/test/mocks/WETHMock.sol",
      "@1inch/solidity-utils/contracts/mocks/TokenMock.sol"
    ]
  },
  typechain: {
    outDir: "typechain-types",
  },
  etherscan: {
    apiKey: {
      // Add your Etherscan API keys here
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      // Add other networks as needed
    }
  }
};

export default config;
