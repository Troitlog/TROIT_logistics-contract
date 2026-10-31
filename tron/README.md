# TROIT escrow contract: Tron (TRC-20 USDT)

A Solidity smart contract for Tron that holds TRC-20 USDT paid for TROIT orders until TROIT releases it to the seller, refunds the buyer, or settles a dispute. Buyers never see the escrow. They get a normal wallet address and send USDT to it from any wallet or exchange.

USDC is not included yet. If USDC goes on Stellar, it needs a separate Soroban contract written in Rust, because Stellar does not run Solidity. If USDC ends up on the same chain as USDT, the admin can turn it on in this contract with `setTokenSupport`.

## How a payment works

1. The backend opens the order on-chain: `openOrder(orderId, USDT, amount)`.
2. Opening the order deploys a deposit address just for that order. The backend shows the buyer `depositAddressOf(orderId)` (convert it to a `T...` address with TronWeb). The payment is matched to the order with no memo or reference needed.
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
- Works with Tron USDT, whose `transfer` returns `false` even when it succeeds. Instead of trusting the return value, every transfer checks that the recipient's balance really went up (`TronTokenTransfer`).
- Wrong tokens or late payments sent to a deposit address can be recovered by the admin. Tokens sent straight to the contract can be swept, but never the money held for orders.

What it does **not** do: the 4-hour and 6-hour timers, evidence checks and the 5% calculation live in the TROIT backend, which calls the contract when the rules are met.

## How it differs from the Ethereum version

- **Deposit addresses are deployed, not predicted.** The Ethereum version computes each order's address in advance with CREATE2. Tron computes CREATE2 addresses differently, and a wrong prediction would send a buyer's money to an address nobody controls. So here `openOrder` deploys the address and stores it. This costs more energy per order, but the address shown to the buyer is always real.
- **Transfers check balances instead of return values**, to cope with Tron USDT (above).
- **Deployment uses TronWeb**, Tron's JavaScript library, instead of Hardhat's network support.

## Running it

Requires Node.js 18 or newer. Tests run on Hardhat's local EVM, which runs the same bytecode Tron does for everything this contract uses, with a test token that copies Tron USDT's behaviour.

```bash
npm install --legacy-peer-deps
npm test
```

Deploy to the Nile testnet first. Get test TRX from the Nile faucet, and use a test TRC-20 token in place of USDT:

```bash
npx hardhat compile
export TRON_PRIVATE_KEY=...     # never commit this
export ADMIN_ADDRESS=T...       # the multisig (Tron supports multi-signature accounts natively)
export USDT_ADDRESS=T...        # USDT, or a test TRC-20 token on Nile
node scripts/deploy-tron.js     # set TRON_FULL_HOST=https://api.trongrid.io for mainnet
```

Fees on Tron are paid in "energy". Either burn TRX for each call, or stake (freeze) TRX to get daily energy, which is much cheaper for the backend's frequent calls.

## Before mainnet

- Deploy to Nile and run a full order (open, pay from a wallet, collect, release, refund, dispute) with real Tron tooling. The deploy script has not been run against a live Tron network yet.
- Confirm on Nile that USDT-style transfers and contract deployment from `openOrder` behave as in the local tests.
- Put the admin role on a multisig, and keep the operator key in a key management service, not in a `.env` file on a server.
- Tether can freeze addresses. If a payee is frozen, `release` reverts; pay that party to a different address.
- Get an independent security audit before real money goes in.
