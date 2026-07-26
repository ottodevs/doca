// SPDX-License-Identifier: MIT
//
// Deploys our side of the stack to real Base, wired to the canonical live Aqua registry.
// Nothing is seeded and no tokens move: this only publishes contracts.
//
//   PRIVATE_KEY=<deployer key, no 0x> BASE_RPC_URL=<rpc> \
//     npx hardhat run scripts/deploy-base.ts --network base
//
// DRY_RUN=1 estimates the total cost against the current gas price and exits without sending.
//
import { writeFileSync } from "fs";
import { join } from "path";
import { BASE } from "./base-addresses";

const { ethers, network } = require("hardhat");

const EXPLORER = "https://basescan.org/address/";

// Deploy order matters: the skew provider takes the router address.
async function main() {
    if (network.name !== "base") throw new Error(`expected --network base, got ${network.name}`);

    const [deployer] = await ethers.getSigners();
    if (!deployer) throw new Error("no signer: set PRIVATE_KEY");
    const who = await deployer.getAddress();
    const balance = await ethers.provider.getBalance(who);
    const fee = await ethers.provider.getFeeData();
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;

    if ((await ethers.provider.getCode(BASE.aqua)) === "0x") {
        throw new Error(`no Aqua at ${BASE.aqua} on this chain`);
    }

    const plan = [
        ["AquaSwapVMRouter", [BASE.aqua, BASE.weth, who, "AquaSwapVM", "1.0.0"]],
        ["DocaApp", [BASE.aqua]],
        ["AquaAMM", [BASE.aqua]],
    ] as const;

    // Estimate everything first so a thin wallet fails before it half-deploys.
    let gasTotal = 0n;
    for (const [name, args] of plan) {
        const factory = await ethers.getContractFactory(name);
        const tx = await factory.getDeployTransaction(...args);
        gasTotal += await ethers.provider.estimateGas({ ...tx, from: who });
    }
    // The skew provider needs a router address; estimate it against a placeholder.
    const skewFactory = await ethers.getContractFactory("InventorySkewProvider");
    gasTotal += await ethers.provider.estimateGas({
        ...(await skewFactory.getDeployTransaction(BASE.aqua, who)), from: who,
    });

    const cost = gasTotal * gasPrice;
    console.log(`deployer   ${who}`);
    console.log(`balance    ${ethers.formatEther(balance)} ETH`);
    console.log(`gas        ${gasTotal} @ ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
    console.log(`estimated  ${ethers.formatEther(cost)} ETH\n`);

    if (process.env.DRY_RUN) return;
    if (balance < cost) throw new Error(`balance below estimate: fund ${who} with a little ETH on Base`);

    const deployed: Record<string, string> = {};
    for (const [name, args] of plan) {
        const factory = await ethers.getContractFactory(name);
        const c = await factory.deploy(...args);
        await c.waitForDeployment();
        deployed[name] = await c.getAddress();
        console.log(`${name.padEnd(18)} ${deployed[name]}`);
    }
    const skew = await skewFactory.deploy(BASE.aqua, deployed.AquaSwapVMRouter);
    await skew.waitForDeployment();
    deployed.InventorySkewProvider = await skew.getAddress();
    console.log(`InventorySkewProvider ${deployed.InventorySkewProvider}`);

    const deployment = {
        chainId: 8453,
        network: "base",
        aqua: BASE.aqua,
        router: deployed.AquaSwapVMRouter,
        docaApp: deployed.DocaApp,
        aquaAmm: deployed.AquaAMM,
        skewProvider: deployed.InventorySkewProvider,
        weth: BASE.weth,
        usdc: BASE.usdc,
        deployer: who,
        deployedAt: (await ethers.provider.getBlockNumber()),
    };
    const out = join(__dirname, "..", "..", "web", "src", "deployment.base.json");
    writeFileSync(out, JSON.stringify(deployment, null, 2) + "\n");

    console.log(`\nwrote ${out}\n`);
    for (const [k, v] of Object.entries(deployed)) console.log(`${k}: ${EXPLORER}${v}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
