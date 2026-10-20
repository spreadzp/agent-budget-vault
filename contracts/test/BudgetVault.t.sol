// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {BudgetVault} from "../BudgetVault.sol";
import {BudgetVaultFactory} from "../BudgetVaultFactory.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal ERC-20 mock with 6 decimals (USDC-like)
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BudgetVaultTest is Test {
    MockUSDC usdc;
    BudgetVaultFactory factory;

    address owner = address(0x1);
    address agent = address(0x2);
    address operator_ = address(0x3);
    address payee1 = address(0x4);
    address payee2 = address(0x5);
    address nobody = address(0x6);
    uint256 agentId = 42;

    BudgetVault vault;

    // 100 USDC (6 decimals)
    uint256 constant ONE_HUNDRED = 100e6;
    uint256 constant ONE_DAY = 1 days;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new BudgetVaultFactory(address(usdc));

        // Create vault via factory
        vm.prank(owner);
        address vaultAddr = factory.createVault(owner, agent, agentId, address(0), operator_);
        vault = BudgetVault(vaultAddr);

        // Give owner tokens and approve vault
        usdc.mint(owner, 10_000e6);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);

        // Add payee1
        vm.prank(owner);
        vault.addPayee(payee1);
    }

    // ─────────────────────────────────────────────────────────────
    // Factory tests
    // ─────────────────────────────────────────────────────────────

    function test_FactoryVaultCount() public {
        assertEq(factory.vaultCount(), 1);
        assertEq(factory.vaults(0), address(vault));
        assertEq(factory.vaultOf(agent), address(vault));
    }

    function test_FactoryCreatesMultipleVaults() public {
        address agent2 = address(0xAA);
        vm.prank(owner);
        factory.createVault(owner, agent2, 43, address(0), address(0));
        assertEq(factory.vaultCount(), 2);
        assertTrue(factory.vaultOf(agent2) != address(0));
    }

    // ─────────────────────────────────────────────────────────────
    // Deposit tests
    // ─────────────────────────────────────────────────────────────

    function test_DepositFirst_SetsSchedule() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (uint256 startTime, uint256 endTime, uint256 rate,,, ) = vault.schedule();
        assertTrue(startTime > 0);
        assertTrue(endTime > startTime);
        assertTrue(rate > 0);
        console.log("rate:", rate);
        console.log("endTime - startTime:", endTime - startTime);
    }

    function test_Deposit_Extend_ProlengsEndTime() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime1,,,,) = vault.schedule();

        // Warp forward a bit
        vm.warp(block.timestamp + 1 days);

        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime2,,,,) = vault.schedule();
        assertTrue(endTime2 > endTime1, "endTime should be extended");
    }

    function test_Deposit_RaiseRate_IncreasesRate() public {
        // First deposit
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, , uint256 rate1,,,) = vault.schedule();

        // Warp so endTime is in the future
        vm.warp(block.timestamp + 1 days);

        // Deposit with RAISE_RATE mode
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.RAISE_RATE);

        (, , uint256 rate2,,,) = vault.schedule();
        assertTrue(rate2 > rate1, "rate should be raised");
    }

    function test_Deposit_RevertIfNotOwner() public {
        vm.prank(nobody);
        vm.expectRevert("NotOwner");
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
    }

    function test_Deposit_RevertIfCancelled() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        vm.prank(owner);
        vault.cancel();

        vm.prank(owner);
        vm.expectRevert("Cancelled");
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
    }

    // ─────────────────────────────────────────────────────────────
    // Vesting accrual
    // ─────────────────────────────────────────────────────────────

    function test_VestingAccrual() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (uint256 startTime, uint256 endTime,,,, ) = vault.schedule();

        // At start: 0 vested
        assertEq(vault.vested(), 0);

        // At midpoint
        uint256 midpoint = startTime + (endTime - startTime) / 2;
        vm.warp(midpoint);
        uint256 v = vault.vested();
        assertTrue(v > 0, "should have vested tokens at midpoint");
        assertTrue(v < ONE_HUNDRED, "should not be fully vested at midpoint");

        // At end — due to integer rounding in rate calculation, vested may be
        // slightly less than totalDeposited; check it is at least 99.9% of it.
        vm.warp(endTime + 1);
        uint256 vestedAtEnd = vault.vested();
        assertTrue(vestedAtEnd >= ONE_HUNDRED * 999 / 1000, "should be ~fully vested at endTime");
    }

    function test_VestingCapAtTotalDeposited() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        // Warp way past endTime — vested is capped at rate*(endTime-startTime) due to integer
        // division; it must be <= totalDeposited and >= 99.9% of it.
        vm.warp(block.timestamp + 365 days);
        uint256 v = vault.vested();
        assertLe(v, ONE_HUNDRED, "vested must not exceed deposited");
        assertGe(v, ONE_HUNDRED * 999 / 1000, "vested should be close to deposited");
    }

    // ─────────────────────────────────────────────────────────────
    // Claim tests
    // ─────────────────────────────────────────────────────────────

    function test_ClaimByAgent() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        uint256 balBefore = usdc.balanceOf(payee1);
        vm.prank(agent);
        vault.claim(50e6, payee1);
        assertEq(usdc.balanceOf(payee1), balBefore + 50e6);
        assertEq(vault.claimed(), 50e6);
    }

    function test_ClaimByOperator() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        uint256 balBefore = usdc.balanceOf(payee1);
        vm.prank(operator_);
        vault.claim(30e6, payee1);
        assertEq(usdc.balanceOf(payee1), balBefore + 30e6);
    }

    function test_Claim_RevertNobody() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        vm.prank(nobody);
        vm.expectRevert("NotAuthorized");
        vault.claim(10e6, payee1);
    }

    function test_Claim_RevertNonAllowlistedPayee() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        vm.prank(agent);
        vm.expectRevert("PayeeNotAllowed");
        vault.claim(10e6, payee2); // payee2 not added
    }

    function test_Claim_RevertInsufficientClaimable() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        // Do NOT warp — nothing vested yet
        vm.prank(agent);
        vm.expectRevert("InsufficientClaimable");
        vault.claim(1e6, payee1);
    }

    // ─────────────────────────────────────────────────────────────
    // PerTxCap
    // ─────────────────────────────────────────────────────────────

    function test_PerTxCap_RevertIfExceeds() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
        vm.prank(owner);
        vault.setPerTxCap(20e6);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        // 25e6 > perTxCap of 20e6
        vm.prank(agent);
        vm.expectRevert("ExceedsPerTxCap");
        vault.claim(25e6, payee1);
    }

    function test_PerTxCap_AllowsExactCap() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);
        vm.prank(owner);
        vault.setPerTxCap(20e6);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        vm.prank(agent);
        vault.claim(20e6, payee1); // exact cap, should succeed
        assertEq(vault.claimed(), 20e6);
    }

    // ─────────────────────────────────────────────────────────────
    // Pause
    // ─────────────────────────────────────────────────────────────

    function test_Pause_BlocksClaim() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        vm.prank(owner);
        vault.pause();

        vm.prank(agent);
        vm.expectRevert("Paused");
        vault.claim(10e6, payee1);
    }

    function test_Unpause_AllowsClaim() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vault.unpause();

        vm.prank(agent);
        vault.claim(10e6, payee1);
        assertEq(vault.claimed(), 10e6);
    }

    function test_Pause_RevertIfNotOwner() public {
        vm.prank(nobody);
        vm.expectRevert("NotOwner");
        vault.pause();
    }

    // ─────────────────────────────────────────────────────────────
    // Cancel
    // ─────────────────────────────────────────────────────────────

    function test_Cancel_ReturnsUnvestedToOwner() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (uint256 startTime, uint256 endTime,,,, ) = vault.schedule();

        // Warp to 30% through the stream
        uint256 cancelAt = startTime + (endTime - startTime) * 30 / 100;
        vm.warp(cancelAt);

        uint256 ownerBalBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.cancel();

        uint256 ownerBalAfter = usdc.balanceOf(owner);
        uint256 returned = ownerBalAfter - ownerBalBefore;
        assertTrue(returned > 0, "owner should receive unvested tokens");
        assertTrue(returned < ONE_HUNDRED, "should not receive everything");
    }

    function test_Cancel_VestedRemainsClaimable() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (uint256 startTime, uint256 endTime,,,, ) = vault.schedule();

        // Warp to 50%
        uint256 cancelAt = startTime + (endTime - startTime) / 2;
        vm.warp(cancelAt);

        vm.prank(owner);
        vault.cancel();

        // After cancel, vested amount (at cancelTime) minus claimed should still be claimable
        uint256 claimableAfterCancel = vault.claimable();
        assertTrue(claimableAfterCancel > 0, "vested funds should remain claimable");

        // Agent can still claim the vested portion
        uint256 payeeBefore = usdc.balanceOf(payee1);
        vm.prank(agent);
        vault.claim(claimableAfterCancel, payee1);
        assertEq(usdc.balanceOf(payee1), payeeBefore + claimableAfterCancel);
    }

    function test_Cancel_DoesNotAccrueAfterCancelTime() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (uint256 startTime, uint256 endTime,,,, ) = vault.schedule();
        uint256 cancelAt = startTime + (endTime - startTime) * 40 / 100;
        vm.warp(cancelAt);

        vm.prank(owner);
        vault.cancel();

        uint256 vestedAtCancel = vault.vested();

        // Warp further — vested should not grow after cancel
        vm.warp(cancelAt + 100 days);
        assertEq(vault.vested(), vestedAtCancel, "vested should freeze after cancel");
    }

    function test_Cancel_RevertIfAlreadyCancelled() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        vm.prank(owner);
        vault.cancel();

        vm.prank(owner);
        vm.expectRevert("AlreadyCancelled");
        vault.cancel();
    }

    function test_Cancel_RevertIfNotOwner() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        vm.prank(nobody);
        vm.expectRevert("NotOwner");
        vault.cancel();
    }

    // ─────────────────────────────────────────────────────────────
    // Payee management
    // ─────────────────────────────────────────────────────────────

    function test_AddPayee() public {
        vm.prank(owner);
        vault.addPayee(payee2);
        assertTrue(vault.isPayee(payee2));
    }

    function test_RemovePayee() public {
        vm.prank(owner);
        vault.addPayee(payee2);
        vm.prank(owner);
        vault.removePayee(payee2);
        assertFalse(vault.isPayee(payee2));
    }

    function test_AddPayee_RevertIfNotOwner() public {
        vm.prank(nobody);
        vm.expectRevert("NotOwner");
        vault.addPayee(payee2);
    }

    // ─────────────────────────────────────────────────────────────
    // Operator
    // ─────────────────────────────────────────────────────────────

    function test_SetOperator() public {
        address newOp = address(0xBEEF);
        vm.prank(owner);
        vault.setOperator(newOp);
        assertEq(vault.operator(), newOp);
    }

    function test_SetOperator_RevertIfNotOwner() public {
        vm.prank(nobody);
        vm.expectRevert("NotOwner");
        vault.setOperator(address(0xBEEF));
    }

    // ─────────────────────────────────────────────────────────────
    // Policy view
    // ─────────────────────────────────────────────────────────────

    function test_PolicyView() public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        (, uint256 endTime,,,, ) = vault.schedule();
        vm.warp(endTime + 1);

        BudgetVault.PolicyView memory p = vault.policy();
        assertEq(p.owner, owner);
        assertEq(p.agent, agent);
        assertEq(p.operator, operator_);
        assertEq(p.agentId, agentId);
        assertEq(p.token, address(usdc));
        assertTrue(p.rate > 0);
        // vested/claimable may be slightly less than ONE_HUNDRED due to integer rounding in rate
        assertGe(p.vested, ONE_HUNDRED * 999 / 1000);
        assertLe(p.vested, ONE_HUNDRED);
        assertGe(p.claimable, ONE_HUNDRED * 999 / 1000);
        assertFalse(p.paused);
        assertFalse(p.cancelled);
        assertEq(p.payees.length, 1);
        assertEq(p.payees[0], payee1);
    }

    // ─────────────────────────────────────────────────────────────
    // OnlyOwner reverts for all owner-only functions
    // ─────────────────────────────────────────────────────────────

    function test_AllOnlyOwnerReverts() public {
        vm.startPrank(nobody);

        vm.expectRevert("NotOwner");
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        vm.expectRevert("NotOwner");
        vault.addPayee(payee2);

        vm.expectRevert("NotOwner");
        vault.removePayee(payee1);

        vm.expectRevert("NotOwner");
        vault.setOperator(address(0xBEEF));

        vm.expectRevert("NotOwner");
        vault.setPerTxCap(100);

        vm.expectRevert("NotOwner");
        vault.pause();

        vm.expectRevert("NotOwner");
        vault.cancel();

        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────
    // Fuzz tests
    // ─────────────────────────────────────────────────────────────

    function testFuzz_VestedNeverExceedsDeposited(uint256 timeDelta) public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        timeDelta = bound(timeDelta, 0, 365 days * 10);
        vm.warp(block.timestamp + timeDelta);

        assertTrue(vault.vested() <= ONE_HUNDRED);
    }

    function testFuzz_ClaimableNeverExceedsVested(uint256 timeDelta) public {
        vm.prank(owner);
        vault.deposit(ONE_HUNDRED, BudgetVault.DepositMode.EXTEND);

        timeDelta = bound(timeDelta, 0, 365 days);
        vm.warp(block.timestamp + timeDelta);

        assertTrue(vault.claimable() <= vault.vested());
    }
}
