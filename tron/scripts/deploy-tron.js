// Deploys TroitEscrow to Tron with USDT as the only supported token.
// Run `npx hardhat compile` first: Tron runs the same compiled bytecode.
//
// Required environment variables:
//   TRON_PRIVATE_KEY  deployer key (never commit it)
//   ADMIN_ADDRESS     T... address of the multisig that will own the contract
//   USDT_ADDRESS      T... address of USDT on the target network
// Optional:
//   TRON_FULL_HOST    defaults to the Nile testnet, https://nile.trongrid.io
//   TRON_API_KEY      TronGrid API key, recommended on mainnet
//   OPERATOR_ADDRESS, ARBITER_ADDRESS, PAUSER_ADDRESS  granted roles if the deployer is the admin
//
// Example: node scripts/deploy-tron.js
const fs = require("fs");
const path = require("path");
const { TronWeb } = require("tronweb");

// Upper bound on TRX burned for energy, in sun (1 TRX = 1,000,000 sun).
const FEE_LIMIT = 1_000_000_000;

async function main() {
  const { TRON_PRIVATE_KEY, ADMIN_ADDRESS, USDT_ADDRESS } = process.env;
  if (!TRON_PRIVATE_KEY || !ADMIN_ADDRESS || !USDT_ADDRESS) {
    throw new Error("Set TRON_PRIVATE_KEY, ADMIN_ADDRESS and USDT_ADDRESS");
  }

  const tronWeb = new TronWeb({
    fullHost: process.env.TRON_FULL_HOST || "https://nile.trongrid.io",
    headers: process.env.TRON_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRON_API_KEY } : undefined,
    privateKey: TRON_PRIVATE_KEY,
  });

  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "TroitEscrow.sol", "TroitEscrow.json");
  const { abi, bytecode } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const escrow = await tronWeb.contract().new({
    abi,
    bytecode,
    feeLimit: FEE_LIMIT,
    parameters: [tronWeb.address.toHex(ADMIN_ADDRESS), [tronWeb.address.toHex(USDT_ADDRESS)]],
  });
  const escrowAddress = tronWeb.address.fromHex(escrow.address);
  console.log("TroitEscrow deployed at", escrowAddress);
  console.log("Deposit implementation at", tronWeb.address.fromHex(await escrow.forwarderImplementation().call()));

  const deployer = tronWeb.defaultAddress.base58;
  if (deployer !== ADMIN_ADDRESS) {
    console.log("Grant OPERATOR_ROLE, ARBITER_ROLE and PAUSER_ROLE from the admin wallet.");
    return;
  }
  const roles = [
    ["OPERATOR_ROLE", process.env.OPERATOR_ADDRESS],
    ["ARBITER_ROLE", process.env.ARBITER_ADDRESS],
    ["PAUSER_ROLE", process.env.PAUSER_ADDRESS],
  ];
  for (const [role, account] of roles) {
    if (!account) continue;
    const roleId = await escrow[role]().call();
    await escrow.grantRole(roleId, tronWeb.address.toHex(account)).send({ feeLimit: FEE_LIMIT });
    console.log(`Granted ${role} to ${account}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
