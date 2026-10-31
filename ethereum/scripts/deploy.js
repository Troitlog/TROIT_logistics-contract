// Deploys TroitEscrow with USDT as the only supported token.
//
// Required environment variables:
//   ADMIN_ADDRESS   multisig wallet that will own the contract (for example a Safe)
//   USDT_ADDRESS    USDT contract on the target chain
// Optional:
//   OPERATOR_ADDRESS, ARBITER_ADDRESS, PAUSER_ADDRESS  granted roles if the deployer is the admin
//
// Example: npx hardhat run scripts/deploy.js --network sepolia
const { ethers } = require("hardhat");

async function main() {
  const admin = process.env.ADMIN_ADDRESS;
  const usdt = process.env.USDT_ADDRESS;
  if (!admin || !usdt) throw new Error("Set ADMIN_ADDRESS and USDT_ADDRESS");

  const escrow = await ethers.deployContract("TroitEscrow", [admin, [usdt]]);
  await escrow.waitForDeployment();
  console.log("TroitEscrow deployed at", await escrow.getAddress());
  console.log("Deposit implementation at", await escrow.forwarderImplementation());

  const [deployer] = await ethers.getSigners();
  if (deployer.address.toLowerCase() !== admin.toLowerCase()) {
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
    await (await escrow.grantRole(await escrow[role](), account)).wait();
    console.log(`Granted ${role} to ${account}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
