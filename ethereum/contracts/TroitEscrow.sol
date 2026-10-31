// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DepositForwarder} from "./DepositForwarder.sol";

/// @title TroitEscrow
/// @notice Holds USDT and USDC paid for TROIT orders until TROIT releases or refunds them.
///
/// How a payment works:
///  1. The backend (OPERATOR) opens an order with its token and expected amount.
///  2. `depositAddressOf(orderId)` gives a unique address for that order. The buyer sends
///     a normal token transfer to it; no wallet connection or approval is needed.
///  3. Anyone calls `collect(orderId)`, which moves the tokens into this contract and
///     records them against the order. The order is Funded once the expected amount arrives.
///  4. The backend calls `release` (pay seller, delivery partner, TROIT fee) or `refund`.
///  5. If a dispute is opened, only the ARBITER (Financial Inspector) can move the money.
///
/// Business rules such as the 6-hour auto-release live in the backend, which calls
/// `release` when they are met. The contract enforces who may move money and that no
/// order ever pays out more than was deposited for it.
contract TroitEscrow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum Status {
        None,
        AwaitingDeposit,
        Funded,
        Disputed,
        Closed,
        Cancelled
    }

    struct Order {
        address token;
        Status status;
        uint256 expectedAmount;
        uint256 deposited;
        uint256 paidOut;
    }

    /// @notice Implementation that every per-order deposit address clones.
    address public immutable forwarderImplementation;

    mapping(address token => bool) public supportedTokens;
    mapping(bytes32 orderId => Order) private _orders;
    /// @notice Sum of all order balances still held, per token.
    mapping(address token => uint256) public totalHeld;

    event TokenSupportSet(address indexed token, bool supported);
    event OrderOpened(bytes32 indexed orderId, address indexed token, uint256 expectedAmount, address depositAddress);
    event OrderCancelled(bytes32 indexed orderId);
    event Deposited(bytes32 indexed orderId, uint256 amount, uint256 totalDeposited);
    event OrderFunded(bytes32 indexed orderId, uint256 totalDeposited);
    event Released(bytes32 indexed orderId, address indexed payee, uint256 amount);
    event Refunded(bytes32 indexed orderId, address indexed to, uint256 amount);
    event DisputeOpened(bytes32 indexed orderId, address indexed by);
    event DisputeResolved(bytes32 indexed orderId, address indexed arbiter, Status newStatus);
    event OrderClosed(bytes32 indexed orderId);
    event Rescued(bytes32 indexed orderId, address indexed token, address indexed to, uint256 amount);
    event ExcessSwept(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedToken(address token);
    error OrderExists(bytes32 orderId);
    error WrongStatus(bytes32 orderId, Status status);
    error ExceedsHeld(bytes32 orderId, uint256 held, uint256 requested);
    error LengthMismatch();
    error NotOperatorOrArbiter();
    error UseCollect();

    constructor(address admin, address[] memory tokens) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        forwarderImplementation = address(new DepositForwarder(address(this)));
        for (uint256 i; i < tokens.length; ++i) {
            _setTokenSupport(tokens[i], true);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /// @notice Amount still held for an order.
    function heldOf(bytes32 orderId) public view returns (uint256) {
        Order storage o = _orders[orderId];
        return o.deposited - o.paidOut;
    }

    /// @notice The address the buyer pays into. Valid before the order is opened.
    function depositAddressOf(bytes32 orderId) public view returns (address) {
        return Clones.predictDeterministicAddress(forwarderImplementation, orderId);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setTokenSupport(address token, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTokenSupport(token, supported);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Recovers tokens stuck at an order's deposit address: a wrong token (for
    ///         example USDC sent to a USDT order), or a late payment to an order that is
    ///         already closed or cancelled. Live orders must use `collect` instead.
    function rescueFromDepositAddress(bytes32 orderId, IERC20 token, address to)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        Order storage o = _orders[orderId];
        if (
            address(token) == o.token
                && (o.status == Status.AwaitingDeposit || o.status == Status.Funded || o.status == Status.Disputed)
        ) revert UseCollect();
        uint256 amount = _forwarder(orderId).sweep(token, to);
        emit Rescued(orderId, address(token), to, amount);
    }

    /// @notice Recovers tokens sent straight to this contract instead of to a deposit
    ///         address. Can never touch money held for orders.
    function sweepExcess(IERC20 token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 excess = token.balanceOf(address(this)) - totalHeld[address(token)];
        if (excess == 0) revert ZeroAmount();
        token.safeTransfer(to, excess);
        emit ExcessSwept(address(token), to, excess);
    }

    // ---------------------------------------------------------------------
    // Order lifecycle
    // ---------------------------------------------------------------------

    function openOrder(bytes32 orderId, address token, uint256 expectedAmount)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        returns (address depositAddress)
    {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (expectedAmount == 0) revert ZeroAmount();
        Order storage o = _orders[orderId];
        if (o.status != Status.None) revert OrderExists(orderId);

        o.token = token;
        o.status = Status.AwaitingDeposit;
        o.expectedAmount = expectedAmount;

        depositAddress = depositAddressOf(orderId);
        emit OrderOpened(orderId, token, expectedAmount, depositAddress);
    }

    /// @notice Cancels an order that never received any payment.
    function cancelOrder(bytes32 orderId) external onlyRole(OPERATOR_ROLE) {
        Order storage o = _orders[orderId];
        if (o.status != Status.AwaitingDeposit || o.deposited != 0) revert WrongStatus(orderId, o.status);
        o.status = Status.Cancelled;
        emit OrderCancelled(orderId);
    }

    /// @notice Pulls whatever the buyer sent to the order's deposit address into escrow.
    ///         Anyone may call it; it only ever credits the order the address belongs to.
    function collect(bytes32 orderId) external nonReentrant whenNotPaused returns (uint256 amount) {
        Order storage o = _orders[orderId];
        Status s = o.status;
        if (s != Status.AwaitingDeposit && s != Status.Funded && s != Status.Disputed) {
            revert WrongStatus(orderId, s);
        }

        IERC20 token = IERC20(o.token);
        uint256 before = token.balanceOf(address(this));
        _forwarder(orderId).sweep(token, address(this));
        // Measure what actually arrived, in case a token ever charges a transfer fee.
        amount = token.balanceOf(address(this)) - before;
        if (amount == 0) revert ZeroAmount();

        o.deposited += amount;
        totalHeld[o.token] += amount;
        emit Deposited(orderId, amount, o.deposited);

        if (s == Status.AwaitingDeposit && o.deposited >= o.expectedAmount) {
            o.status = Status.Funded;
            emit OrderFunded(orderId, o.deposited);
        }
    }

    /// @notice Pays out held funds, for example to the seller, the delivery partner
    ///         and TROIT's fee wallet, in one call. Blocked while a dispute is open.
    function release(bytes32 orderId, address[] calldata payees, uint256[] calldata amounts)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        Order storage o = _orders[orderId];
        if (o.status != Status.Funded) revert WrongStatus(orderId, o.status);
        _payMany(orderId, o, payees, amounts, false);
        _closeIfEmpty(orderId, o);
    }

    /// @notice Returns money to the buyer: a cancellation, a sold-out item, or an
    ///         underpaid order that will not be completed. Blocked while disputed.
    function refund(bytes32 orderId, address to, uint256 amount)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        Order storage o = _orders[orderId];
        if (o.status != Status.Funded && o.status != Status.AwaitingDeposit) {
            revert WrongStatus(orderId, o.status);
        }
        _pay(orderId, o, to, amount, true);
        _closeIfEmpty(orderId, o);
    }

    /// @notice Freezes an order's funds until the arbiter resolves the dispute.
    function openDispute(bytes32 orderId) external whenNotPaused {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(ARBITER_ROLE, msg.sender)) {
            revert NotOperatorOrArbiter();
        }
        Order storage o = _orders[orderId];
        if (o.status != Status.Funded) revert WrongStatus(orderId, o.status);
        o.status = Status.Disputed;
        emit DisputeOpened(orderId, msg.sender);
    }

    /// @notice The Financial Inspector's decision. Pays each party its share (refunds to
    ///         the buyer, money for a replacement seller, and so on). Anything left stays
    ///         held and the order returns to Funded; an empty order closes.
    /// @param refundTo Buyer address for `refundAmount`; ignored when the amount is zero.
    function resolveDispute(
        bytes32 orderId,
        address[] calldata payees,
        uint256[] calldata amounts,
        address refundTo,
        uint256 refundAmount
    ) external onlyRole(ARBITER_ROLE) nonReentrant whenNotPaused {
        Order storage o = _orders[orderId];
        if (o.status != Status.Disputed) revert WrongStatus(orderId, o.status);

        _payMany(orderId, o, payees, amounts, true);
        if (refundAmount > 0) _pay(orderId, o, refundTo, refundAmount, true);

        o.status = Status.Funded;
        if (!_closeIfEmpty(orderId, o)) emit DisputeResolved(orderId, msg.sender, Status.Funded);
        else emit DisputeResolved(orderId, msg.sender, Status.Closed);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _setTokenSupport(address token, bool supported) private {
        if (token == address(0)) revert ZeroAddress();
        supportedTokens[token] = supported;
        emit TokenSupportSet(token, supported);
    }

    /// @dev Deploys the order's deposit clone on first use.
    function _forwarder(bytes32 orderId) private returns (DepositForwarder) {
        address addr = depositAddressOf(orderId);
        if (addr.code.length == 0) {
            Clones.cloneDeterministic(forwarderImplementation, orderId);
        }
        return DepositForwarder(addr);
    }

    function _payMany(
        bytes32 orderId,
        Order storage o,
        address[] calldata payees,
        uint256[] calldata amounts,
        bool allowEmpty
    ) private {
        if (payees.length != amounts.length) revert LengthMismatch();
        if (payees.length == 0 && !allowEmpty) revert ZeroAmount();
        for (uint256 i; i < payees.length; ++i) {
            _pay(orderId, o, payees[i], amounts[i], false);
        }
    }

    function _pay(bytes32 orderId, Order storage o, address to, uint256 amount, bool isRefund) private {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 held = o.deposited - o.paidOut;
        if (amount > held) revert ExceedsHeld(orderId, held, amount);

        o.paidOut += amount;
        totalHeld[o.token] -= amount;
        IERC20(o.token).safeTransfer(to, amount);

        if (isRefund) emit Refunded(orderId, to, amount);
        else emit Released(orderId, to, amount);
    }

    function _closeIfEmpty(bytes32 orderId, Order storage o) private returns (bool closed) {
        if (o.deposited == o.paidOut && o.deposited >= o.expectedAmount) {
            o.status = Status.Closed;
            emit OrderClosed(orderId);
            return true;
        }
        if (o.status == Status.AwaitingDeposit && o.deposited == o.paidOut) {
            // A partial payment was fully refunded: the order will not go ahead.
            o.status = Status.Cancelled;
            emit OrderCancelled(orderId);
            return true;
        }
        return false;
    }
}
