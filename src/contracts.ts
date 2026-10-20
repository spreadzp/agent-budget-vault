/**
 * Agent Allowance — contract config.
 * Addresses are populated after deploy; update AGENTS.md and this file.
 */
import factoryArtifact from '../contracts/out/BudgetVaultFactory.sol/BudgetVaultFactory.json';
import vaultArtifact from '../contracts/out/BudgetVault.sol/BudgetVault.json';

export const ARC_TESTNET_CHAIN_ID = 5042002;

// Set after deploy — also stored in AGENTS.md
export const FACTORY_ADDRESS = (
  import.meta.env.VITE_FACTORY_ADDRESS ?? ''
) as `0x${string}`;

export const FACTORY_ABI = factoryArtifact.abi;
export const VAULT_ABI = vaultArtifact.abi;
