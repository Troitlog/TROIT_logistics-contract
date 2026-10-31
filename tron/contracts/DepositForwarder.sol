// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TronTokenTransfer} from "./TronTokenTransfer.sol";

/// @title DepositForwarder (Tron)
/// @notice Implementation behind each order's deposit address. The escrow deploys a
///         minimal clone of this contract when it opens an order, and the buyer pays
///         that address with a plain TRC-20 transfer from any wallet or exchange.
/// @dev Clones delegatecall into this code, so the immutable `escrow` is shared by
///      every clone and only the escrow that deployed the implementation can sweep.
contract DepositForwarder {
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
        if (amount > 0) TronTokenTransfer.send(token, to, amount);
    }
}
