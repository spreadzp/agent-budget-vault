// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BudgetVault} from "../BudgetVault.sol";
import {BudgetVaultFactory} from "../BudgetVaultFactory.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Hardening tests for SLICE-202-2 review findings F1-F6.
contract BudgetVaultHardeningTest is Test {
    MockUSDC usdc;
    BudgetVaultFactory factory;

    address owner = address(0x1);
    address agent = address(0x2);
    address operator_ = address(0x3);
    address payee1 = address(0x4);

    BudgetVault vault;

    uint256 constant ONE_HUNDRED = 100e6;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new BudgetVaultFactory(address(usdc));

        vm.prank(owner);
        vault = BudgetVault(
            factory.createVault(owner, agent, 42, address(0), operator_)
        );

        usdc.mint(owner, 10_000e6);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(owner);
        vault.addPayee(payee1);
    }

    // F1: first deposit must establish rate > 0, else funds never vest
    function test_Deposit_RevertIfAmountTooSmall() public {
        // 1 USDC < 2592000 => amount / 30 days == 0 => rate would be 0
        vm.prank(owner);
        vm.expectRevert("AmountTooSmall");
        vault.deposit(1e6, BudgetVault.DepositMode.EXTEND);
    }

    // F2: EXTEND must ceil-divide so the full amount vests (no locked dust)
    function test_Deposit_Extend_NoLockedDust() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
        (, uint256 endTime1, uint256 rate1,,,) = vault.schedule();

        vm.warp(block.timestamp + 1 days);
        uint256 topUp = 7e6 + 12345; // not divisible by rate
        vm.prank(owner);
        vault.deposit(topUp, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime2, uint256 rate2,,,) = vault.schedule();
        assertEq(rate2, rate1, "EXTEND must keep the rate");
        // added duration must cover the whole topUp: rate * delta >= topUp
        assertGe(
            rate1 * (endTime2 - endTime1),
            topUp,
            "extension must vest the full deposit"
        );

        // everything is claimable at end — nothing left locked
        vm.warp(endTime2 + 1);
        assertEq(vault.vested(), ONE_HUNDRED + topUp);
    }

    // F3: EXTEND on an expired vault must revert (new funds would vest instantly)
    function test_Deposit_Extend_RevertIfExpired() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
        (, uint256 endTime,,,,) = vault.schedule();

        vm.warp(endTime + 1);
        vm.prank(owner);
        vm.expectRevert("vault expired");
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
    }

    // EXTEND while active must not change already-vested amount
    function test_Deposit_Extend_PreservesVested() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,,) = vault.schedule();
        uint256 mid = block.timestamp + (endTime - block.timestamp) / 2;
        vm.warp(mid);
        uint256 vestedBefore = vault.vested();

        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
        assertEq(vault.vested(), vestedBefore, "vested must not jump");
    }

    // F4: factory must reject a second vault for the same agent
    function test_Factory_RevertDuplicateAgent() public {
        vm.prank(owner);
        vm.expectRevert("VaultExists");
        factory.createVault(owner, agent, 99, address(0), operator_);
        assertEq(factory.vaultOf(agent), address(vault));
    }

    // F5: zero-address guards in constructor
    function test_Constructor_RevertZeroOwner() public {
        vm.expectRevert("ZeroAddress");
        new BudgetVault(
            address(0), agent, 1, address(0), address(0), address(usdc)
        );
    }

    function test_Constructor_RevertZeroAgent() public {
        vm.expectRevert("ZeroAddress");
        new BudgetVault(
            owner, address(0), 1, address(0), address(0), address(usdc)
        );
    }

    function test_Constructor_RevertZeroToken() public {
        vm.expectRevert("ZeroAddress");
        new BudgetVault(
            owner, agent, 1, address(0), address(0), address(0)
        );
    }

    function test_Factory_RevertZeroAgent() public {
        vm.prank(owner);
        vm.expectRevert("ZeroAddress");
        factory.createVault(owner, address(0), 1, address(0), operator_);
    }

    // F6: removePayee on a non-listed address emits nothing
    function test_RemovePayee_NoEventWhenNotListed() public {
        vm.recordLogs();
        vm.prank(owner);
        vault.removePayee(address(0xBEEF));
        assertEq(vm.getRecordedLogs().length, 0, "no event for non-payee");
    }
}
