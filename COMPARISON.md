# Ethereum vs Tron escrow: side by side

Both contracts do the same job with the same functions, roles and safety rules: per-order deposit addresses, release and refund by the TROIT backend, disputes settled only by the Financial Inspector, pause, and recovery of mistaken transfers. The differences come from how each chain and its USDT behave.

## What changes in the code

| | Ethereum (`ethereum/`) | Tron (`tron/`) |
| --- | --- | --- |
| Deposit address | Predicted with CREATE2 and deployed on first `collect` | Deployed by `openOrder` and stored on the order |
| Can you show the address before opening the order? | Yes | No, only after `openOrder` |
| Token transfers | OpenZeppelin `SafeERC20` | `TronTokenTransfer`: ignores the return value, checks the recipient's balance |
| Why | Standard, well audited | Tron USDT returns `false` even when a transfer succeeds, so `SafeERC20` would reject every payment |
| Deploy tool | Hardhat (`scripts/deploy.js`) | TronWeb (`scripts/deploy-tron.js`) |
| Testnet | Sepolia | Nile |
| Tests | 26 passing | 28 passing (adds the Tron USDT and fake-transfer cases) |
| Tested on a live testnet | Not yet | Not yet |

## Cost per order (measured locally)

Gas from Hardhat's local network for one order: open, collect, and release to two payees (seller and delivery partner). On Tron the same work is billed as "energy", which roughly tracks gas. Real USDT costs a little more than the test tokens, so treat these as a guide only.

| Step | Ethereum gas | Tron energy (approx.) |
| --- | --- | --- |
| `openOrder` | 76,383 | 139,471 |
| `collect` | 159,146 | 123,886 |
| `release` to 2 payees | 121,170 | 127,936 |
| **Total** | **356,699** | **391,293** |

Tron uses about 10% more total because it deploys the deposit address when the order opens instead of on first collect. What each unit costs in money is very different, though. Ethereum's price swings with network demand, while on Tron the backend can stake TRX for daily energy and pay little or nothing per call.

## Which to pick for TROIT

Tron, for the same reason as before: Nigerian buyers mostly already hold USDT on Tron, so paying needs no bridging and the transfer fee is low. Keep the Ethereum version if you later want to accept ERC-20 USDT from users who hold it there. The backend can run both side by side, one contract per chain.
