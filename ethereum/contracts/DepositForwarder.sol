// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DepositForwarder
/// @notice Implementation behind each order's deposit address. The escrow deploys a
///         minimal clone of this contract at a deterministic address per order, so a
///         buyer can pay with a plain token transfer from any wallet or exchange.
/// @dev Clones delegatecall into this code, so the immutable `escrow` is shared by
///      every clone and only the escrow that deployed the implementation can sweep.
contract DepositForwarder {
    using SafeERC20 for IERC20;

    address public immutable escrow;

    error NotEscrow();

    constructor(address escrow_) {
        escrow = escrow_;
    }

    /// @notice Moves this address's whole balance of `token` to `to`.
    /// @return amount The amount moved.
    function sweep(IERC20 token, address to) external returns (uint256 amount) {
        if (msg.sender != escrow) revert NotEscrow();
        amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
