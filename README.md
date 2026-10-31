# TROIT USDT escrow contracts

Two versions of the same escrow contract, so they can be compared:

- [`ethereum/`](ethereum/README.md): ERC-20 USDT on Ethereum-style chains.
- [`tron/`](tron/README.md): TRC-20 USDT on Tron.
- [`COMPARISON.md`](COMPARISON.md): what differs and why, with gas and energy figures.

Each folder is its own project: `cd ethereum && npm install --legacy-peer-deps && npm test`, and the same for `tron`.
