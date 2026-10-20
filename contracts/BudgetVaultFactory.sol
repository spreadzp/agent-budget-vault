// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BudgetVault} from "./BudgetVault.sol";

contract BudgetVaultFactory {
    address public token;
    address[] public vaults;
    mapping(address => address) public vaultOf;

    event VaultCreated(
        address indexed owner,
        address indexed agent,
        uint256 agentId,
        address registry,
        address operator,
        address vault
    );

    constructor(address _token) {
        require(_token != address(0), "ZeroAddress");
        token = _token;
    }

    function createVault(
        address owner,
        address agent,
        uint256 agentId,
        address registry,
        address operator
    ) external returns (address vault) {
        require(owner != address(0) && agent != address(0), "ZeroAddress");
        require(vaultOf[agent] == address(0), "VaultExists");
        vault = address(new BudgetVault(owner, agent, agentId, registry, operator, token));
        vaults.push(vault);
        vaultOf[agent] = vault;

        emit VaultCreated(owner, agent, agentId, registry, operator, vault);
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
