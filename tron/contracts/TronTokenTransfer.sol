// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title TronTokenTransfer
/// @notice Token transfer that works with USDT on Tron.
/// @dev Tron's USDT contract is known to return `false` from `transfer` even when the
///      transfer succeeds, so OpenZeppelin's SafeERC20 (which trusts the return value)
///      would reject every payment. Instead this ignores the return value and checks
///      that the recipient's balance actually went up by the amount sent.
library TronTokenTransfer {
    error TransferFailed(address token, address to, uint256 amount);

    function send(IERC20 token, address to, uint256 amount) internal {
        uint256 before = token.balanceOf(to);
        (bool ok,) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || token.balanceOf(to) != before + amount) {
            revert TransferFailed(address(token), to, amount);
        }
    }
}
