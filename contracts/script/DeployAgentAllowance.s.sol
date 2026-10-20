// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BudgetVaultFactory} from "../BudgetVaultFactory.sol";

/**
 * @title DeployAgentAllowance
 * @notice Deploy BudgetVaultFactory to Arc Testnet (chainId 5042002) or Arc Mainnet (chainId 5042).
 *
 * Required env vars:
 *   USDC_TOKEN_ADDRESS   — ERC-20 USDC address on the target chain
 *   PRIVATE_KEY          — deployer private key (for local/self-deploy runs)
 *
 * Arc Testnet USDC: 0x3600000000000000000000000000000000000000
 * Arc Mainnet USDC: 0x3600000000000000000000000000000000000000
 *
 * Run (Arc Testnet):
 *   forge script contracts/script/DeployAgentAllowance.s.sol \
 *     --rpc-url https://rpc.testnet.arc.io \
 *     --broadcast \
 *     --verify
 */
contract DeployAgentAllowance is Script {
    function run() external {
        address usdcToken = vm.envAddress("USDC_TOKEN_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        BudgetVaultFactory factory = new BudgetVaultFactory(usdcToken);
        console.log("BudgetVaultFactory deployed at:", address(factory));
        console.log("USDC token:", usdcToken);
        console.log("Chain ID:", block.chainid);

        vm.stopBroadcast();
    }
}
