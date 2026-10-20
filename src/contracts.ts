/**
 * Agent Allowance — contract config.
 * Addresses are populated after deploy; update AGENTS.md and this file.
 */
import factoryArtifact from '../contracts/out/BudgetVaultFactory.sol/BudgetVaultFactory.json';
import vaultArtifact from '../contracts/out/BudgetVault.sol/BudgetVault.json';

export const ARC_TESTNET_CHAIN_ID = 5042002;

// Target chain — Arc testnet by default; set VITE_CHAIN_ID=5042 for mainnet.
export const ARC_CHAIN_ID = Number(
  import.meta.env.VITE_CHAIN_ID ?? ARC_TESTNET_CHAIN_ID,
);

// Set after deploy — also stored in AGENTS.md
export const FACTORY_ADDRESS = (
  import.meta.env.VITE_FACTORY_ADDRESS ?? ''
) as `0x${string}`;

export const FACTORY_ABI = factoryArtifact.abi;
export const VAULT_ABI = vaultArtifact.abi;
