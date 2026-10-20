// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract BudgetVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum DepositMode {
        EXTEND,
        RAISE_RATE
    }

    struct PolicyView {
        address owner;
        address agent;
        address operator;
        uint256 agentId;
        address registry;
        address token;
        uint256 rate;
        uint256 startTime;
        uint256 endTime;
        uint256 perTxCap;
        bool paused;
        bool cancelled;
        uint256 vested;
        uint256 claimed;
        uint256 claimable;
        address[] payees;
    }

    address public owner;
    address public agent;
    address public operator;
    uint256 public agentId;
    address public registry;
    IERC20 public token;
    uint256 public rate;
    uint256 public startTime;
    uint256 public endTime;
    uint256 public claimed;
    bool public paused;
    bool public cancelled;
    uint256 public cancelTime;
    uint256 public perTxCap;
    address[] private _payees;
    mapping(address => bool) private _isPayee;
    uint256 private _totalDeposited;

    event Deposited(address indexed owner, uint256 amount, DepositMode mode, uint256 newRate, uint256 newEndTime);
    event Claimed(address indexed caller, address indexed payee, uint256 amount);
    event PayeeAdded(address indexed payee);
    event PayeeRemoved(address indexed payee);
    event OperatorSet(address indexed operator);
    event PerTxCapSet(uint256 cap);
    event Paused();
    event Unpaused();
    event Cancelled(address indexed owner, uint256 unvested);

    modifier onlyOwner() {
        require(msg.sender == owner, "NotOwner");
        _;
    }

    constructor(address _owner, address _agent, uint256 _agentId, address _registry, address _operator, address _token) {
        require(_owner != address(0) && _agent != address(0) && _token != address(0), "ZeroAddress");
        owner = _owner;
        agent = _agent;
        agentId = _agentId;
        registry = _registry;
        operator = _operator;
        token = IERC20(_token);
    }

    function deposit(uint256 amount, DepositMode mode) external onlyOwner nonReentrant {
        require(amount > 0, "ZeroAmount");
        require(!cancelled, "Cancelled");

        token.safeTransferFrom(msg.sender, address(this), amount);
        _totalDeposited += amount;

        if (startTime == 0) {
            // First deposit: mode is ignored, a fresh 30-day stream is derived.
            startTime = block.timestamp;
            if (rate == 0) {
                rate = amount / 30 days;
                require(rate > 0, "AmountTooSmall");
            }
            // ceil division: extension covers the whole deposit, no dust locked
            endTime = startTime + (amount + rate - 1) / rate;
        } else if (mode == DepositMode.EXTEND) {
            if (endTime <= block.timestamp) {
                // Restart an expired stream: keep vested() continuous by
                // anchoring startTime so vested(now) is unchanged, then vest
                // the new deposit over a fresh window from now.
                startTime = block.timestamp - (_vestedAt(block.timestamp) / rate);
                endTime = block.timestamp + (amount + rate - 1) / rate;
            } else {
                endTime += (amount + rate - 1) / rate;
            }
        } else {
            require(endTime > block.timestamp, "vault expired");
            uint256 remaining = endTime - block.timestamp;
            // ceil so the unclaimed remainder fully vests before endTime;
            // a rate that rounds to 0 would freeze vesting forever.
            rate = (_totalDeposited - claimed + remaining - 1) / remaining;
            require(rate > 0, "RateTooLow");
        }

        emit Deposited(msg.sender, amount, mode, rate, endTime);
    }

    function claim(uint256 amount, address payee) external nonReentrant {
        require(msg.sender == agent || msg.sender == operator, "NotAuthorized");
        require(!paused, "Paused");
        require(_isPayee[payee], "PayeeNotAllowed");
        require(amount > 0, "ZeroAmount");

        if (perTxCap > 0) {
            require(amount <= perTxCap, "ExceedsPerTxCap");
        }

        uint256 c = claimable();
        require(amount <= c, "InsufficientClaimable");

        claimed += amount;

        token.safeTransfer(payee, amount);

        emit Claimed(msg.sender, payee, amount);
    }

    function addPayee(address payee) external onlyOwner {
        require(payee != address(0), "ZeroAddress");
        if (!_isPayee[payee]) {
            _payees.push(payee);
            _isPayee[payee] = true;
            emit PayeeAdded(payee);
        }
    }

    function removePayee(address payee) external onlyOwner {
        if (_isPayee[payee]) {
            _isPayee[payee] = false;
            uint256 len = _payees.length;
            for (uint256 i = 0; i < len; i++) {
                if (_payees[i] == payee) {
                    _payees[i] = _payees[len - 1];
                    _payees.pop();
                    break;
                }
            }
            emit PayeeRemoved(payee);
        }
    }

    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
        emit OperatorSet(_operator);
    }

    function setPerTxCap(uint256 cap) external onlyOwner {
        perTxCap = cap;
        emit PerTxCapSet(cap);
    }

    function pause() external onlyOwner {
        require(!paused, "AlreadyPaused");
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        require(paused, "NotPaused");
        paused = false;
        emit Unpaused();
    }

    function cancel() external onlyOwner nonReentrant {
        require(!cancelled, "AlreadyCancelled");

        cancelled = true;
        cancelTime = block.timestamp;

        uint256 v = _vestedAt(cancelTime);
        uint256 unvested = _totalDeposited > v ? _totalDeposited - v : 0;

        // Transfer unconditionally: balance == _totalDeposited - claimed holds
        // by construction, and a silent skip would lock funds forever.
        if (unvested > 0) {
            token.safeTransfer(owner, unvested);
        }

        emit Cancelled(owner, unvested);
    }

    function vested() public view returns (uint256) {
        return _vestedAt(block.timestamp);
    }

    function claimable() public view returns (uint256) {
        uint256 v = vested();
        if (v <= claimed) {
            return 0;
        }
        return v - claimed;
    }

    function isPayee(address addr) external view returns (bool) {
        return _isPayee[addr];
    }

    function schedule()
        external
        view
        returns (uint256 _startTime, uint256 _endTime, uint256 _rate, uint256 _totalDep, uint256 _claimed, uint256 _vested)
    {
        return (startTime, endTime, rate, _totalDeposited, claimed, vested());
    }

    function policy() external view returns (PolicyView memory) {
        address[] memory payees = _payees;
        uint256 v = vested();
        uint256 c = v > claimed ? v - claimed : 0;

        return
            PolicyView({
                owner: owner,
                agent: agent,
                operator: operator,
                agentId: agentId,
                registry: registry,
                token: address(token),
                rate: rate,
                startTime: startTime,
                endTime: endTime,
                perTxCap: perTxCap,
                paused: paused,
                cancelled: cancelled,
                vested: v,
                claimed: claimed,
                claimable: c,
                payees: payees
            });
    }

    function _vestedAt(uint256 ts) internal view returns (uint256) {
        if (rate == 0 || startTime == 0) {
            return 0;
        }

        uint256 effectiveEnd = cancelled ? cancelTime : endTime;
        if (ts <= startTime) {
            return 0;
        }

        uint256 elapsed;
        if (ts > effectiveEnd) {
            elapsed = effectiveEnd - startTime;
        } else {
            elapsed = ts - startTime;
        }

        uint256 accrued = rate * elapsed;
        return accrued < _totalDeposited ? accrued : _totalDeposited;
    }
}
