# TROIT escrow contract: Ethereum (ERC-20 USDT)

A Solidity smart contract that holds USDT paid for TROIT orders until TROIT releases it to the seller, refunds the buyer, or settles a dispute. Buyers never see the escrow. They get a normal wallet address and send USDT to it from any wallet or exchange.

USDC is not included yet. If USDC goes on Stellar, it needs a separate Soroban contract written in Rust, because Stellar does not run Solidity. If USDC ends up on the same chain as USDT, the admin can turn it on in this contract with `setTokenSupport`.

## How a payment works

1. The backend opens the order on-chain: `openOrder(orderId, USDT, amount)`.
2. The backend shows the buyer `depositAddressOf(orderId)`. Every order has its own address, so the payment is matched to the order with no memo or reference needed.
3. The buyer sends USDT to that address.
4. The backend (or anyone) calls `collect(orderId)`. The USDT moves into the escrow and the order becomes **Funded** once the full amount has arrived. Partial payments are kept and wait for a top-up.
5. When the buyer confirms receipt, or the 6-hour rule passes with no dispute, the backend calls `release(orderId, [seller, deliveryPartner], [amounts])`.
6. For cancellations the backend calls `refund(orderId, buyer, amount)`, and can `release` the 5% charge and delivery fee in the same flow.
7. If there is a problem, `openDispute(orderId)` freezes the money. Only the Financial Inspector (`ARBITER_ROLE`) can then move it, with `resolveDispute`.

```
AwaitingDeposit --full payment--> Funded --release/refund to zero--> Closed
      |                            |  ^
      | (unpaid) cancelOrder       |  | resolveDispute (money left)
      v                            v  |
  Cancelled                      Disputed --resolveDispute (all paid out)--> Closed
```

## Roles

| Role | Who should hold it | Can do |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | A multisig wallet (for example Safe) owned by TROIT leadership | Grant roles, add or remove tokens, unpause, rescue mistaken transfers |
| `OPERATOR_ROLE` | The TROIT backend's hot wallet | Open, cancel, release, refund, open disputes |
| `ARBITER_ROLE` | The Financial Inspector's wallet | Open and settle disputes |
| `PAUSER_ROLE` | An on-call admin wallet | Pause all money movement in an emergency |

## Safety rules the contract enforces

- An order can never pay out more than was deposited for it, and one order's money can never pay another.
- While disputed, only the arbiter can move the money.
- Works with USDT's non-standard `transfer` (no return value) through OpenZeppelin `SafeERC20`.
- Wrong tokens or late payments sent to a deposit address can be recovered by the admin. Tokens sent straight to the contract can be swept, but never the money held for orders.

What it does **not** do: the 4-hour and 6-hour timers, evidence checks and the 5% calculation live in the TROIT backend, which calls the contract when the rules are met.

## Running it

Requires Node.js 18 or newer.

```bash
npm install --legacy-peer-deps
npm test
```

Deploy (testnet first):

```bash
export SEPOLIA_RPC_URL=...      # RPC endpoint
export DEPLOYER_KEY=...         # never commit this
export ADMIN_ADDRESS=0x...      # the multisig
export USDT_ADDRESS=0x...       # USDT on that chain (a test token on testnets)
npx hardhat run scripts/deploy.js --network sepolia
```

## Before mainnet

- Decide the chain. The code targets Ethereum-style chains (Ethereum, BNB Chain, Polygon, Base) and compiles with `evmVersion: paris` for wide compatibility.
- For Tron, use the separate version in `../tron`.
- Put the admin role on a multisig, and keep the operator key in a key management service, not in a `.env` file on a server.
- USDT can freeze addresses. If a payee is frozen, `release` reverts; pay that party to a different address.
- Get an independent security audit before real money goes in.
