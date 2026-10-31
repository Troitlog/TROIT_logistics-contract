const { expect } = require("chai");
const { ethers } = require("hardhat");

const usdt = (n) => ethers.parseUnits(String(n), 6);
const id = (s) => ethers.id(s);

const Status = { None: 0n, AwaitingDeposit: 1n, Funded: 2n, Disputed: 3n, Closed: 4n, Cancelled: 5n };

describe("TroitEscrow (Tron)", function () {
  let escrow, token, other;
  let admin, operator, arbiter, pauser, buyer, seller, rider, treasury, stranger;

  beforeEach(async function () {
    [admin, operator, arbiter, pauser, buyer, seller, rider, treasury, stranger] = await ethers.getSigners();

    token = await ethers.deployContract("MockTronUSDT");
    other = await ethers.deployContract("MockERC20", ["USD Coin", "USDC"]);
    escrow = await ethers.deployContract("TroitEscrow", [admin.address, [await token.getAddress()]]);

    await escrow.grantRole(await escrow.OPERATOR_ROLE(), operator.address);
    await escrow.grantRole(await escrow.ARBITER_ROLE(), arbiter.address);
    await escrow.grantRole(await escrow.PAUSER_ROLE(), pauser.address);

    await token.mint(buyer.address, usdt(10_000));
    await other.mint(buyer.address, usdt(10_000));
  });

  // Opens an order and has the buyer pay into its deposit address, then collects.
  async function fundedOrder(name, amount) {
    const orderId = id(name);
    await escrow.connect(operator).openOrder(orderId, await token.getAddress(), amount);
    await token.connect(buyer).transfer(await escrow.depositAddressOf(orderId), amount);
    await escrow.collect(orderId);
    return orderId;
  }

  describe("setup", function () {
    it("only supports the tokens it was deployed with", async function () {
      expect(await escrow.supportedTokens(await token.getAddress())).to.equal(true);
      expect(await escrow.supportedTokens(await other.getAddress())).to.equal(false);
    });

    it("lets only the admin change supported tokens", async function () {
      await expect(escrow.connect(operator).setTokenSupport(await other.getAddress(), true)).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount"
      );
      await escrow.setTokenSupport(await other.getAddress(), true);
      expect(await escrow.supportedTokens(await other.getAddress())).to.equal(true);
    });
  });

  describe("opening and paying an order", function () {
    it("deploys each order its own deposit address when the order opens", async function () {
      expect(await escrow.depositAddressOf(id("A"))).to.equal(ethers.ZeroAddress);
      await expect(escrow.connect(operator).openOrder(id("A"), await token.getAddress(), usdt(100))).to.emit(
        escrow,
        "OrderOpened"
      );
      await escrow.connect(operator).openOrder(id("B"), await token.getAddress(), usdt(100));
      const a = await escrow.depositAddressOf(id("A"));
      const b = await escrow.depositAddressOf(id("B"));
      expect(a).to.not.equal(ethers.ZeroAddress);
      expect(a).to.not.equal(b);
      expect(await ethers.provider.getCode(a)).to.not.equal("0x");
      expect((await escrow.getOrder(id("A"))).depositAddress).to.equal(a);
    });

    it("rejects unsupported tokens, zero amounts, duplicates and non-operators", async function () {
      const t = await token.getAddress();
      await expect(escrow.connect(operator).openOrder(id("A"), await other.getAddress(), usdt(1))).to.be.revertedWithCustomError(
        escrow,
        "UnsupportedToken"
      );
      await expect(escrow.connect(operator).openOrder(id("A"), t, 0)).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await escrow.connect(operator).openOrder(id("A"), t, usdt(1));
      await expect(escrow.connect(operator).openOrder(id("A"), t, usdt(1))).to.be.revertedWithCustomError(escrow, "OrderExists");
      await expect(escrow.connect(stranger).openOrder(id("B"), t, usdt(1))).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("works with Tron USDT, whose transfer returns false on success", async function () {
      const orderId = await fundedOrder("A", usdt(103));
      const o = await escrow.getOrder(orderId);
      expect(o.status).to.equal(Status.Funded);
      expect(o.deposited).to.equal(usdt(103));
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(usdt(103));
      expect(await escrow.totalHeld(await token.getAddress())).to.equal(usdt(103));
    });

    it("stays awaiting deposit after a partial payment and funds on the top-up", async function () {
      const orderId = id("A");
      await escrow.connect(operator).openOrder(orderId, await token.getAddress(), usdt(100));
      const dep = await escrow.depositAddressOf(orderId);

      await token.connect(buyer).transfer(dep, usdt(60));
      await expect(escrow.connect(stranger).collect(orderId)).to.emit(escrow, "Deposited").withArgs(orderId, usdt(60), usdt(60));
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.AwaitingDeposit);

      await token.connect(buyer).transfer(dep, usdt(40));
      await expect(escrow.collect(orderId)).to.emit(escrow, "OrderFunded").withArgs(orderId, usdt(100));
    });

    it("reverts collect when nothing was sent or the order is unknown", async function () {
      await escrow.connect(operator).openOrder(id("A"), await token.getAddress(), usdt(1));
      await expect(escrow.collect(id("A"))).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(escrow.collect(id("nope"))).to.be.revertedWithCustomError(escrow, "WrongStatus");
    });

    it("cancels an unpaid order", async function () {
      await escrow.connect(operator).openOrder(id("A"), await token.getAddress(), usdt(1));
      await escrow.connect(operator).cancelOrder(id("A"));
      expect((await escrow.getOrder(id("A"))).status).to.equal(Status.Cancelled);
    });
  });

  describe("token safety", function () {
    it("rejects a transfer that reports success but moves nothing", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await token.setFakeTransfers(true);
      await expect(escrow.connect(operator).release(orderId, [seller.address], [usdt(100)])).to.be.revertedWithCustomError(
        escrow,
        "TransferFailed"
      );
      expect(await escrow.heldOf(orderId)).to.equal(usdt(100));
    });
  });

  describe("release", function () {
    it("splits one payment between seller, delivery partner and TROIT, then closes", async function () {
      // 100 USDT phone + 3 USDT delivery, buyer confirmed.
      const orderId = await fundedOrder("A", usdt(103));
      await expect(
        escrow.connect(operator).release(orderId, [seller.address, rider.address], [usdt(100), usdt(3)])
      )
        .to.emit(escrow, "Released")
        .withArgs(orderId, seller.address, usdt(100))
        .and.to.emit(escrow, "OrderClosed");

      expect(await token.balanceOf(seller.address)).to.equal(usdt(100));
      expect(await token.balanceOf(rider.address)).to.equal(usdt(3));
      expect(await escrow.totalHeld(await token.getAddress())).to.equal(0);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Closed);
    });

    it("allows partial releases for split orders", async function () {
      const orderId = await fundedOrder("A", usdt(200));
      await escrow.connect(operator).release(orderId, [seller.address], [usdt(120)]);
      expect(await escrow.heldOf(orderId)).to.equal(usdt(80));
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Funded);
    });

    it("never pays out more than the order holds", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await expect(escrow.connect(operator).release(orderId, [seller.address], [usdt(101)])).to.be.revertedWithCustomError(
        escrow,
        "ExceedsHeld"
      );
    });

    it("cannot use one order's money for another", async function () {
      const a = await fundedOrder("A", usdt(100));
      await fundedOrder("B", usdt(100));
      await escrow.connect(operator).release(a, [seller.address], [usdt(100)]);
      await expect(escrow.connect(operator).release(a, [seller.address], [usdt(1)])).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
      expect(await escrow.heldOf(id("B"))).to.equal(usdt(100));
    });

    it("rejects bad input and non-operators", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await expect(escrow.connect(operator).release(orderId, [seller.address], [])).to.be.revertedWithCustomError(
        escrow,
        "LengthMismatch"
      );
      await expect(escrow.connect(operator).release(orderId, [], [])).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(escrow.connect(operator).release(orderId, [ethers.ZeroAddress], [1])).to.be.revertedWithCustomError(
        escrow,
        "ZeroAddress"
      );
      await expect(escrow.connect(stranger).release(orderId, [stranger.address], [1])).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("cannot release before the order is funded", async function () {
      await escrow.connect(operator).openOrder(id("A"), await token.getAddress(), usdt(100));
      await expect(escrow.connect(operator).release(id("A"), [seller.address], [1])).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
    });
  });

  describe("refund", function () {
    it("handles a cancellation after pickup: buyer refund, fee and delivery kept", async function () {
      // Total 103: refund 103 - 5.15 - 3 = 94.85; 5.15 to TROIT, 3 to delivery.
      const orderId = await fundedOrder("A", usdt(103));
      await escrow.connect(operator).refund(orderId, buyer.address, usdt("94.85"));
      await escrow.connect(operator).release(orderId, [treasury.address, rider.address], [usdt("5.15"), usdt(3)]);
      expect(await token.balanceOf(buyer.address)).to.equal(usdt("9991.85"));
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Closed);
    });

    it("refunds a partial payment and cancels the order", async function () {
      const orderId = id("A");
      await escrow.connect(operator).openOrder(orderId, await token.getAddress(), usdt(100));
      await token.connect(buyer).transfer(await escrow.depositAddressOf(orderId), usdt(30));
      await escrow.collect(orderId);
      await expect(escrow.connect(operator).refund(orderId, buyer.address, usdt(30))).to.emit(escrow, "OrderCancelled");
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Cancelled);
    });
  });

  describe("disputes", function () {
    it("blocks release and refund by the operator while disputed", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await escrow.connect(operator).openDispute(orderId);
      await expect(escrow.connect(operator).release(orderId, [seller.address], [1])).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
      await expect(escrow.connect(operator).refund(orderId, buyer.address, 1)).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
    });

    it("lets only operator or arbiter open a dispute", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await expect(escrow.connect(stranger).openDispute(orderId)).to.be.revertedWithCustomError(escrow, "NotOperatorOrArbiter");
      await expect(escrow.connect(arbiter).openDispute(orderId)).to.emit(escrow, "DisputeOpened");
    });

    it("lets only the arbiter settle: full refund closes the order", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await escrow.connect(operator).openDispute(orderId);
      await expect(escrow.connect(operator).resolveDispute(orderId, [], [], buyer.address, usdt(100))).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount"
      );
      await expect(escrow.connect(arbiter).resolveDispute(orderId, [], [], buyer.address, usdt(100)))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(orderId, arbiter.address, Status.Closed);
      expect(await token.balanceOf(buyer.address)).to.equal(usdt(10_000));
    });

    it("can pay a replacement seller and leave the rest held", async function () {
      const orderId = await fundedOrder("A", usdt(103));
      await escrow.connect(arbiter).openDispute(orderId);
      await escrow.connect(arbiter).resolveDispute(orderId, [stranger.address], [usdt(100)], ethers.ZeroAddress, 0);
      const o = await escrow.getOrder(orderId);
      expect(o.status).to.equal(Status.Funded);
      expect(await escrow.heldOf(orderId)).to.equal(usdt(3));
    });

    it("still collects a late top-up while disputed", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await escrow.connect(operator).openDispute(orderId);
      await token.connect(buyer).transfer(await escrow.depositAddressOf(orderId), usdt(5));
      await escrow.collect(orderId);
      expect(await escrow.heldOf(orderId)).to.equal(usdt(105));
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Disputed);
    });
  });

  describe("pause", function () {
    it("stops money movement until the admin unpauses", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await escrow.connect(pauser).pause();
      await expect(escrow.connect(operator).release(orderId, [seller.address], [usdt(100)])).to.be.revertedWithCustomError(
        escrow,
        "EnforcedPause"
      );
      await expect(escrow.connect(pauser).unpause()).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      await escrow.unpause();
      await escrow.connect(operator).release(orderId, [seller.address], [usdt(100)]);
    });
  });

  describe("recovering mistakes", function () {
    it("refuses to rescue from an order that was never opened", async function () {
      await expect(escrow.rescueFromDepositAddress(id("nope"), await other.getAddress(), buyer.address)).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
    });

    it("rescues a wrong token sent to a deposit address, but not the order's own token", async function () {
      const orderId = id("A");
      await escrow.connect(operator).openOrder(orderId, await token.getAddress(), usdt(100));
      const dep = await escrow.depositAddressOf(orderId);
      await other.connect(buyer).transfer(dep, usdt(50));

      await expect(escrow.rescueFromDepositAddress(orderId, await token.getAddress(), treasury.address)).to.be.revertedWithCustomError(
        escrow,
        "UseCollect"
      );
      await expect(
        escrow.connect(operator).rescueFromDepositAddress(orderId, await other.getAddress(), treasury.address)
      ).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");

      await escrow.rescueFromDepositAddress(orderId, await other.getAddress(), buyer.address);
      expect(await other.balanceOf(buyer.address)).to.equal(usdt(10_000));
    });

    it("rescues a late payment sent to a closed order's deposit address", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await escrow.connect(operator).release(orderId, [seller.address], [usdt(100)]);
      await token.connect(buyer).transfer(await escrow.depositAddressOf(orderId), usdt(20));
      await expect(escrow.collect(orderId)).to.be.revertedWithCustomError(escrow, "WrongStatus");
      await escrow.rescueFromDepositAddress(orderId, await token.getAddress(), buyer.address);
      expect(await token.balanceOf(buyer.address)).to.equal(usdt(9_900));
    });

    it("sweeps tokens sent straight to the contract without touching held funds", async function () {
      const orderId = await fundedOrder("A", usdt(100));
      await token.connect(buyer).transfer(await escrow.getAddress(), usdt(7));
      await escrow.sweepExcess(await token.getAddress(), treasury.address);
      expect(await token.balanceOf(treasury.address)).to.equal(usdt(7));
      expect(await escrow.heldOf(orderId)).to.equal(usdt(100));
      await expect(escrow.sweepExcess(await token.getAddress(), treasury.address)).to.be.revertedWithCustomError(
        escrow,
        "ZeroAmount"
      );
    });

    it("does not let anyone else sweep a deposit address", async function () {
      const impl = await ethers.getContractAt("DepositForwarder", await escrow.forwarderImplementation());
      await expect(impl.connect(stranger).sweep(await token.getAddress(), stranger.address)).to.be.revertedWithCustomError(
        impl,
        "NotEscrow"
      );
    });
  });
});
