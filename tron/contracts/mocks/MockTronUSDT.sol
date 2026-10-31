// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only token that mimics Tron USDT: 6 decimals, and `transfer` that
///      moves the tokens but still returns false.
contract MockTronUSDT {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;

    /// @dev When true, `transfer` returns true without moving anything, to test that
    ///      the escrow checks balances rather than trusting return values.
    bool public fakeTransfers;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFakeTransfers(bool fake) external {
        fakeTransfers = fake;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (fakeTransfers) return true;
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return false;
    }
}
