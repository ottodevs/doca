// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1

import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import 'hardhat-deploy';

// Canonical WETH addresses per network (used when WETH_ADDRESS env is not set)
const WETH_ADDRESSES: Record<string, string> = {
  mainnet: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  sepolia: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log('Deploying contracts with account:', deployer);

  const isLocalNetwork = hre.network.name === 'localhost' || hre.network.name === 'hardhat';

  // Deploy Aqua
  const aquaDeploy = await deploy('Aqua', {
    from: deployer,
    args: [],
    log: true,
    waitConfirmations: 1,
  });

  console.log(`Aqua deployed at: ${aquaDeploy.address}`);

  // Deploy AquaAMM
  const aquaAMMDeploy = await deploy('AquaAMM', {
    from: deployer,
    args: [aquaDeploy.address],
    log: true,
    waitConfirmations: 1,
  });

  console.log(`AquaAMM deployed at: ${aquaAMMDeploy.address}`);

  // Resolve WETH: deploy a mock locally, use canonical/env address elsewhere
  let wethAddress = process.env.WETH_ADDRESS || WETH_ADDRESSES[hre.network.name];
  if (!wethAddress) {
    if (!isLocalNetwork) {
      throw new Error(`WETH address is not configured for network '${hre.network.name}'. Set WETH_ADDRESS env variable.`);
    }
    const wethDeploy = await deploy('WETHMock', {
      from: deployer,
      args: [],
      log: true,
      waitConfirmations: 1,
    });
    wethAddress = wethDeploy.address;
    console.log(`WETHMock deployed at: ${wethAddress}`);
  }

  // Deploy AquaSwapVMRouter
  const aquaSwapVMRouterArgs = [
    aquaDeploy.address,
    wethAddress,
    deployer, // owner (can rescue funds)
    'AquaSwapVM',
    '1.0.0'
  ];
  const aquaSwapVMRouterDeploy = await deploy('AquaSwapVMRouter', {
    from: deployer,
    args: aquaSwapVMRouterArgs,
    log: true,
    waitConfirmations: 1,
  });

  console.log(`AquaSwapVMRouter deployed at: ${aquaSwapVMRouterDeploy.address}`);

  // Deploy MockTaker for testing (optional, can be commented out for production)
  const mockTakerDeploy = await deploy('MockTaker', {
    from: deployer,
    args: [
      aquaDeploy.address,
      aquaSwapVMRouterDeploy.address,
      deployer
    ],
    log: true,
    waitConfirmations: 1,
  });

  console.log(`MockTaker deployed at: ${mockTakerDeploy.address}`);

  console.log('\n=== Deployment Summary ===');
  console.log(`Aqua: ${aquaDeploy.address}`);
  console.log(`AquaAMM: ${aquaAMMDeploy.address}`);
  console.log(`WETH: ${wethAddress}`);
  console.log(`AquaSwapVMRouter: ${aquaSwapVMRouterDeploy.address}`);
  console.log(`MockTaker: ${mockTakerDeploy.address}`);
  console.log('==========================\n');

  // Verify contracts if not on localhost
  if (!isLocalNetwork) {
    console.log('Waiting for block confirmations...');
    await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30 seconds

    console.log('Verifying contracts...');

    try {
      await hre.run('verify:verify', {
        address: aquaDeploy.address,
        constructorArguments: [],
      });
      console.log(`Aqua verified`);
    } catch (error) {
      console.error('Failed to verify Aqua:', error);
    }

    try {
      await hre.run('verify:verify', {
        address: aquaAMMDeploy.address,
        constructorArguments: [aquaDeploy.address],
      });
      console.log(`AquaAMM verified`);
    } catch (error) {
      console.error('Failed to verify AquaAMM:', error);
    }

    try {
      await hre.run('verify:verify', {
        address: aquaSwapVMRouterDeploy.address,
        constructorArguments: aquaSwapVMRouterArgs,
      });
      console.log(`AquaSwapVMRouter verified`);
    } catch (error) {
      console.error('Failed to verify AquaSwapVMRouter:', error);
    }

    try {
      await hre.run('verify:verify', {
        address: mockTakerDeploy.address,
        constructorArguments: [
          aquaDeploy.address,
          aquaSwapVMRouterDeploy.address,
          deployer
        ],
      });
      console.log(`MockTaker verified`);
    } catch (error) {
      console.error('Failed to verify MockTaker:', error);
    }
  }
};

export default func;
func.tags = ['Aqua', 'AquaAMM', 'AquaSwapVMRouter', 'MockTaker'];
func.dependencies = [];
