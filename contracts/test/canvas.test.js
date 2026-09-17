const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mainnetGuard, FLYBRAIN, RH_CHAIN_ID, RH_RPC_URL } = require("../scripts/lib");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = ethers.ZeroAddress;
const PRICE = ethers.parseEther("100000"); // INITIAL_PRICE, 100,000 $FLYBRAIN
const MAXB = ethers.MaxUint256; // maxBurn when a test is not about it
const GAS = {};

const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const roots = (tag) => [h("root:" + tag), h("input:" + tag)];
const gasOf = async (txp) => (await (await txp).wait()).gasUsed;

/// Deploys token + canvas and funds three claimers with unlimited allowances.
async function setup(opts = {}) {
  const [owner, op, alice, bob, carol] = await ethers.getSigners();
  const kind = opts.token || "MockERC20";
  const TF = await ethers.getContractFactory(kind);
  const token = kind === "MockERC20Reenter" ? await TF.deploy() : await TF.deploy("FlyBrain", "FLYBRAIN");
  await token.waitForDeployment();
  const F = await ethers.getContractFactory("FlyonardoCanvas");
  const canvas = await F.deploy(await token.getAddress(), op.address);
  await canvas.waitForDeployment();
  const addr = await canvas.getAddress();
  for (const u of [alice, bob, carol]) {
    await token.mint(u.address, ethers.parseEther("1000000000"));
    await token.connect(u).approve(addr, ethers.MaxUint256);
  }
  if (kind === "MockERC20Reenter") await token.setCanvas(addr, 1, true);
  return { canvas, token, addr, owner, op, alice, bob, carol };
}

/// One painter commit on the live canvas.
function commit(canvas, op, id, strokes, tag = "t") {
  const [r, i] = roots(tag);
  return canvas.connect(op).commit(id, r, i, strokes);
}

/// A canvas painted once and claimed by `who`; returns the commit's tag data.
async function paintAndClaim(canvas, op, who, id, strokes = 10, tag = "t") {
  await commit(canvas, op, id, strokes, tag);
  await canvas.connect(who).claim(id, MAXB);
  return roots(tag);
}

describe("deploy", () => {
  it("starts on canvas 1 at 100,000 $FLYBRAIN with nothing painted", async () => {
    const { canvas, token, op, owner } = await setup();
    expect(await canvas.name()).to.equal("Flyonardo da Vinci");
    expect(await canvas.symbol()).to.equal("FLYONARDO");
    expect(await canvas.owner()).to.equal(owner.address);
    expect(await canvas.operator()).to.equal(op.address);
    expect(await canvas.token()).to.equal(await token.getAddress());
    expect(await canvas.price()).to.equal(PRICE);
    expect(await canvas.INITIAL_PRICE()).to.equal(PRICE);
    expect(await canvas.DEAD()).to.equal(DEAD);
    expect(await canvas.FIRST_CANVAS()).to.equal(1n);
    expect(await canvas.currentCanvas()).to.equal(1n);
    expect(await canvas.totalSupply()).to.equal(0n);
    expect(await canvas.baseURI()).to.equal("");
    const c = await canvas.current();
    expect([c.canvasId, c.strokeRoot, c.inputHash, c.strokes, c.commits, c.commitBlock, c.commitTime])
      .to.deep.equal([1n, ethers.ZeroHash, ethers.ZeroHash, 0n, 0n, 0n, 0n]);
    await expect(canvas.canvasOf(1)).to.be.revertedWithCustomError(canvas, "NotFrozen");
  });

  it("emits its opening state, including the first blank canvas", async () => {
    const [owner, op] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("FlyBrain", "FLYBRAIN");
    const F = await ethers.getContractFactory("FlyonardoCanvas");
    const canvas = await F.deploy(await token.getAddress(), op.address);
    const tx = canvas.deploymentTransaction();
    await expect(tx).to.emit(canvas, "OwnerSet").withArgs(owner.address)
      .and.to.emit(canvas, "OperatorSet").withArgs(op.address)
      .and.to.emit(canvas, "PriceSet").withArgs(PRICE)
      .and.to.emit(canvas, "CanvasStarted").withArgs(1);
    GAS["deploy"] = (await tx.wait()).gasUsed;
  });

  it("refuses a zero or non-contract token and a zero operator", async () => {
    const [owner, op] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("FlyBrain", "FLYBRAIN");
    const t = await token.getAddress();
    const F = await ethers.getContractFactory("FlyonardoCanvas");
    await expect(F.deploy(ZERO, op.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(t, ZERO)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(owner.address, op.address)).to.be.revertedWithCustomError(F, "NotAContract");
  });

  it("claims the ERC-165/721/721Metadata interface ids its ABI actually implements", async () => {
    const { canvas } = await setup();
    const sel = (sig) => ethers.getBytes(ethers.dataSlice(ethers.id(sig), 0, 4));
    const xorOf = (sigs) => {
      const acc = new Uint8Array(4);
      for (const s of sigs) {
        canvas.interface.getFunction(s); // throws if the ABI lacks that exact signature
        const b = sel(s);
        for (let i = 0; i < 4; i++) acc[i] ^= b[i];
      }
      return ethers.hexlify(acc);
    };
    expect(xorOf(["supportsInterface(bytes4)"])).to.equal("0x01ffc9a7");
    expect(xorOf([
      "balanceOf(address)", "ownerOf(uint256)",
      "safeTransferFrom(address,address,uint256,bytes)", "safeTransferFrom(address,address,uint256)",
      "transferFrom(address,address,uint256)", "approve(address,uint256)",
      "setApprovalForAll(address,bool)", "getApproved(uint256)", "isApprovedForAll(address,address)",
    ])).to.equal("0x80ac58cd");
    expect(xorOf(["name()", "symbol()", "tokenURI(uint256)"])).to.equal("0x5b5e139f");

    for (const id of ["0x01ffc9a7", "0x80ac58cd", "0x5b5e139f"]) {
      expect(await canvas.supportsInterface(id)).to.equal(true);
    }
    for (const id of ["0xffffffff", "0x780e9d63" /* Enumerable, not implemented */, "0x00000000"]) {
      expect(await canvas.supportsInterface(id)).to.equal(false);
    }
    // ERC-721 requires all three Transfer/Approval args and both ApprovalForAll addresses indexed.
    const ev = (n) => canvas.interface.getEvent(n).inputs.map((i) => [i.type, i.indexed]);
    expect(ev("Transfer")).to.deep.equal([["address", true], ["address", true], ["uint256", true]]);
    expect(ev("Approval")).to.deep.equal([["address", true], ["address", true], ["uint256", true]]);
    expect(ev("ApprovalForAll")).to.deep.equal([["address", true], ["address", true], ["bool", false]]);
    // Tokens are only ever minted by claim: there is no burn, no mint, no owner escape hatch.
    const fns = canvas.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const banned of ["burn", "mint", "safeMint", "withdraw", "freeze", "setCanvas", "setToken"]) {
      expect(fns).to.not.include(banned);
    }
    expect(canvas.interface.fragments.some((f) => f.type === "fallback" || f.type === "receive")).to.equal(false);
  });
});

describe("commit", () => {
  it("records root, inputHash, strokes, block and time, and counts commits", async () => {
    const { canvas, op } = await setup();
    const [r, i] = roots("a");
    const tx = canvas.connect(op).commit(1, r, i, 7);
    await expect(tx).to.emit(canvas, "Committed").withArgs(1, 7, r, i, 1);
    const rc = await (await tx).wait();
    GAS["commit first"] = rc.gasUsed;
    const blk = await ethers.provider.getBlock(rc.blockNumber);
    const c = await canvas.current();
    expect([c.canvasId, c.strokeRoot, c.inputHash, c.strokes, c.commits, c.commitBlock, c.commitTime])
      .to.deep.equal([1n, r, i, 7n, 1n, BigInt(rc.blockNumber), BigInt(blk.timestamp)]);

    const [r2, i2] = roots("b");
    GAS["commit later"] = await gasOf(canvas.connect(op).commit(1, r2, i2, 19));
    const c2 = await canvas.current();
    expect([c2.strokeRoot, c2.inputHash, c2.strokes, c2.commits]).to.deep.equal([r2, i2, 19n, 2n]);
  });

  it("is operator-only; the owner is not the painter", async () => {
    const { canvas, owner, op, alice } = await setup();
    const [r, i] = roots("a");
    await expect(canvas.connect(owner).commit(1, r, i, 1)).to.be.revertedWithCustomError(canvas, "NotOperator");
    await expect(canvas.connect(alice).commit(1, r, i, 1)).to.be.revertedWithCustomError(canvas, "NotOperator");
    await canvas.connect(op).commit(1, r, i, 1);
    // rotating the operator moves the brush, and only the brush
    await canvas.connect(owner).setOperator(alice.address);
    await expect(canvas.connect(op).commit(1, r, i, 2)).to.be.revertedWithCustomError(canvas, "NotOperator");
    await canvas.connect(alice).commit(1, r, i, 2);
    expect((await canvas.current()).commits).to.equal(2n);
  });

  it("only ever writes the current canvas", async () => {
    const { canvas, op, alice } = await setup();
    const [r, i] = roots("a");
    await expect(canvas.connect(op).commit(0, r, i, 1)).to.be.revertedWithCustomError(canvas, "NotCurrentCanvas").withArgs(1);
    await expect(canvas.connect(op).commit(2, r, i, 1)).to.be.revertedWithCustomError(canvas, "NotCurrentCanvas").withArgs(1);
    await paintAndClaim(canvas, op, alice, 1);
    // canvas 1 is frozen: no commit can ever reach it again
    await expect(canvas.connect(op).commit(1, r, i, 99)).to.be.revertedWithCustomError(canvas, "NotCurrentCanvas").withArgs(2);
    await canvas.connect(op).commit(2, r, i, 1);
    expect((await canvas.current()).canvasId).to.equal(2n);
  });

  it("lets the stroke count stand still but never go backwards", async () => {
    const { canvas, op, alice } = await setup();
    await commit(canvas, op, 1, 5, "a");
    await commit(canvas, op, 1, 5, "b"); // fly stood still, fresh chain input
    expect((await canvas.current()).commits).to.equal(2n);
    await expect(commit(canvas, op, 1, 4, "c"))
      .to.be.revertedWithCustomError(canvas, "StrokesDecreased").withArgs(5, 4);
    await expect(commit(canvas, op, 1, 0, "c"))
      .to.be.revertedWithCustomError(canvas, "StrokesDecreased").withArgs(5, 0);
    await commit(canvas, op, 1, 6, "d");
    expect((await canvas.current()).strokes).to.equal(6n);

    // the counter belongs to the canvas, so a blank one starts from zero again
    await canvas.connect(alice).claim(1, MAXB);
    await commit(canvas, op, 2, 1, "e");
    expect((await canvas.current()).strokes).to.equal(1n);
  });

  it("accepts a first commit of zero strokes (a blank window still carries chain input)", async () => {
    const { canvas, op } = await setup();
    const [r, i] = roots("a");
    await canvas.connect(op).commit(1, r, i, 0);
    const c = await canvas.current();
    expect([c.strokes, c.commits]).to.deep.equal([0n, 1n]);
  });
});

describe("claim", () => {
  it("burns exactly the price to 0x...dEaD and mints the canvas to the caller", async () => {
    const { canvas, token, addr, op, alice } = await setup();
    const [r, i] = roots("a");
    await canvas.connect(op).commit(1, r, i, 42);
    const commitBlock = await ethers.provider.getBlockNumber();
    const before = await token.balanceOf(alice.address);

    const tx = canvas.connect(alice).claim(1, MAXB);
    await expect(tx)
      .to.emit(canvas, "Claimed").withArgs(1, alice.address, PRICE, r, i, 42, 1, commitBlock)
      .and.to.emit(canvas, "Transfer").withArgs(ZERO, alice.address, 1)
      .and.to.emit(canvas, "CanvasStarted").withArgs(2)
      .and.to.emit(token, "Transfer").withArgs(alice.address, DEAD, PRICE);
    GAS["claim"] = (await (await tx).wait()).gasUsed;

    expect(await token.balanceOf(DEAD)).to.equal(PRICE);
    expect(await token.balanceOf(alice.address)).to.equal(before - PRICE);
    expect(await token.balanceOf(addr)).to.equal(0n); // the contract never holds anything
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
    expect(await canvas.balanceOf(alice.address)).to.equal(1n);
    expect(await canvas.totalSupply()).to.equal(1n);
    expect(await canvas.currentCanvas()).to.equal(2n);
    const live = await canvas.current();
    expect([live.canvasId, live.strokeRoot, live.inputHash, live.strokes, live.commits, live.commitBlock, live.commitTime])
      .to.deep.equal([2n, ethers.ZeroHash, ethers.ZeroHash, 0n, 0n, 0n, 0n]);
  });

  it("freezes the LAST commit, not the first and not a later one", async () => {
    const { canvas, op, alice, bob } = await setup();
    await commit(canvas, op, 1, 5, "first");
    await commit(canvas, op, 1, 50, "middle");
    await commit(canvas, op, 1, 500, "last");
    const [lastR, lastI] = roots("last");
    const commitBlock = await ethers.provider.getBlockNumber();
    const commitTime = (await ethers.provider.getBlock(commitBlock)).timestamp;

    const rc = await (await canvas.connect(alice).claim(1, MAXB)).wait();
    const claimTime = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
    const c = await canvas.canvasOf(1);
    expect([c.strokeRoot, c.inputHash, c.strokes, c.commits]).to.deep.equal([lastR, lastI, 500n, 3n]);
    expect([c.commitBlock, c.commitTime]).to.deep.equal([BigInt(commitBlock), BigInt(commitTime)]);
    expect([c.claimBlock, c.claimTime]).to.deep.equal([BigInt(rc.blockNumber), BigInt(claimTime)]);
    expect([c.claimer, c.burned]).to.deep.equal([alice.address, PRICE]);
    expect(c.commitBlock).to.be.lessThan(c.claimBlock);
    const [firstR] = roots("first");
    expect(c.strokeRoot).to.not.equal(firstR);

    // painting canvas 2, and claiming it, leaves canvas 1 exactly as frozen
    await commit(canvas, op, 2, 9, "next");
    await canvas.connect(bob).claim(2, MAXB);
    const again = await canvas.canvasOf(1);
    expect([again.strokeRoot, again.strokes, again.commits, again.claimer])
      .to.deep.equal([lastR, 500n, 3n, alice.address]);
    const two = await canvas.canvasOf(2);
    expect([two.strokes, two.commits, two.claimer]).to.deep.equal([9n, 1n, bob.address]);
    expect(await canvas.ownerOf(2)).to.equal(bob.address);
    expect(await canvas.totalSupply()).to.equal(2n);
  });

  it("refuses a canvas with nothing committed yet", async () => {
    const { canvas, token, op, alice } = await setup();
    await expect(canvas.connect(alice).claim(1, MAXB)).to.be.revertedWithCustomError(canvas, "NothingCommitted");
    expect(await token.balanceOf(DEAD)).to.equal(0n);
    // and again on the blank canvas that follows a claim
    await paintAndClaim(canvas, op, alice, 1);
    await expect(canvas.connect(alice).claim(2, MAXB)).to.be.revertedWithCustomError(canvas, "NothingCommitted");
    expect(await canvas.totalSupply()).to.equal(1n);
  });

  it("refuses a stale or future canvas id", async () => {
    const { canvas, op, alice, bob } = await setup();
    await commit(canvas, op, 1, 3, "a");
    await expect(canvas.connect(alice).claim(2, MAXB)).to.be.revertedWithCustomError(canvas, "NotCurrentCanvas").withArgs(1);
    await expect(canvas.connect(alice).claim(0, MAXB)).to.be.revertedWithCustomError(canvas, "NotCurrentCanvas").withArgs(1);
    await canvas.connect(alice).claim(1, MAXB);
    // bob's transaction was written against canvas 1 and must not silently take canvas 2
    await expect(canvas.connect(bob).claim(1, MAXB)).to.be.revertedWithCustomError(canvas, "NotCurrentCanvas").withArgs(2);
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
    await expect(canvas.ownerOf(2)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
  });

  it("never burns more than maxBurn, whatever the owner does to the price", async () => {
    const { canvas, token, owner, op, alice } = await setup();
    await commit(canvas, op, 1, 3, "a");
    const shown = PRICE;
    await canvas.connect(owner).setPrice(PRICE * 3n);
    await expect(canvas.connect(alice).claim(1, shown))
      .to.be.revertedWithCustomError(canvas, "PriceAboveMax").withArgs(PRICE * 3n, shown);
    expect(await token.balanceOf(DEAD)).to.equal(0n);
    await expect(canvas.connect(alice).claim(1, PRICE * 3n - 1n))
      .to.be.revertedWithCustomError(canvas, "PriceAboveMax").withArgs(PRICE * 3n, PRICE * 3n - 1n);
    // the exact price passes, and so does a lowered one
    await canvas.connect(owner).setPrice(PRICE);
    await expect(canvas.connect(alice).claim(1, shown)).to.emit(canvas, "Claimed");
    expect(await token.balanceOf(DEAD)).to.equal(PRICE);
  });

  it("burns the price in force at the moment of the claim", async () => {
    const { canvas, token, owner, op, alice } = await setup();
    await canvas.connect(owner).setPrice(PRICE / 4n);
    await paintAndClaim(canvas, op, alice, 1);
    expect(await token.balanceOf(DEAD)).to.equal(PRICE / 4n);
    expect((await canvas.canvasOf(1)).burned).to.equal(PRICE / 4n);
    await canvas.connect(owner).setPrice(PRICE * 2n);
    await paintAndClaim(canvas, op, alice, 2);
    expect(await token.balanceOf(DEAD)).to.equal(PRICE / 4n + PRICE * 2n);
    expect((await canvas.canvasOf(2)).burned).to.equal(PRICE * 2n);
  });

  it("reverts without allowance or balance, and nothing is frozen", async () => {
    const { canvas, token, addr, op, alice, bob, carol } = await setup();
    const [, , , , , poor] = await ethers.getSigners();
    await commit(canvas, op, 1, 3, "a");
    await expect(canvas.connect(poor).claim(1, MAXB)).to.be.revertedWithCustomError(canvas, "TransferFailed");
    await token.connect(bob).approve(addr, PRICE - 1n);
    await expect(canvas.connect(bob).claim(1, MAXB)).to.be.revertedWithCustomError(canvas, "TransferFailed");
    await token.connect(carol).transfer(alice.address, await token.balanceOf(carol.address));
    await expect(canvas.connect(carol).claim(1, MAXB)).to.be.revertedWithCustomError(canvas, "TransferFailed");
    expect(await canvas.currentCanvas()).to.equal(1n);
    expect(await canvas.totalSupply()).to.equal(0n);
    await expect(canvas.canvasOf(1)).to.be.revertedWithCustomError(canvas, "NotFrozen");
  });

  it("a fee-on-transfer token cannot under-burn", async () => {
    const { canvas, token, op, alice } = await setup({ token: "MockERC20Tax" });
    await commit(canvas, op, 1, 3, "a");
    await expect(canvas.connect(alice).claim(1, MAXB))
      .to.be.revertedWithCustomError(canvas, "BurnMismatch").withArgs(PRICE, (PRICE * 95n) / 100n);
    expect(await token.balanceOf(DEAD)).to.equal(0n);
    expect(await canvas.currentCanvas()).to.equal(1n);
    expect(await canvas.totalSupply()).to.equal(0n);
  });

  it("a transferFrom that answers false is refused even though the tokens moved", async () => {
    const { canvas, op, alice } = await setup({ token: "MockERC20FalseReturn" });
    await commit(canvas, op, 1, 3, "a");
    await expect(canvas.connect(alice).claim(1, MAXB)).to.be.revertedWithCustomError(canvas, "TransferFailed");
    expect(await canvas.totalSupply()).to.equal(0n);
  });

  it("a transferFrom that returns nothing at all is accepted", async () => {
    const { canvas, token, op, alice } = await setup({ token: "MockERC20NoReturn" });
    await paintAndClaim(canvas, op, alice, 1);
    expect(await token.balanceOf(DEAD)).to.equal(PRICE);
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
  });

  it("a token that calls back into claim hits the reentrancy lock", async () => {
    const { canvas, token, addr, op, alice } = await setup({ token: "MockERC20Reenter" });
    const REENTRANCY = ethers.dataSlice(ethers.id("Reentrancy()"), 0, 4); // the revert the lock throws
    await commit(canvas, op, 1, 3, "a");
    await canvas.connect(alice).claim(1, MAXB);
    expect(await token.reenterCalls()).to.equal(1n);
    expect(await token.lastRevert()).to.equal(REENTRANCY); // the lock, not a price or id check
    expect(await canvas.totalSupply()).to.equal(1n); // minted exactly once
    expect(await canvas.currentCanvas()).to.equal(2n);
    expect(await canvas.balanceOf(alice.address)).to.equal(1n);

    // the lock is on the whole function, so a re-entry aimed at another id fails the same way
    await token.setCanvas(addr, 7, true);
    await commit(canvas, op, 2, 3, "b");
    await canvas.connect(alice).claim(2, MAXB);
    expect(await token.lastRevert()).to.equal(REENTRANCY);
    expect(await canvas.totalSupply()).to.equal(2n);

    // and a token that lets the lock's revert bubble takes the whole claim down with it
    await token.setCanvas(addr, 3, false);
    await commit(canvas, op, 3, 3, "c");
    await expect(canvas.connect(alice).claim(3, MAXB)).to.be.revertedWithCustomError(canvas, "TransferFailed");
    expect(await canvas.totalSupply()).to.equal(2n);
    expect(await canvas.currentCanvas()).to.equal(3n);
    await expect(canvas.canvasOf(3)).to.be.revertedWithCustomError(canvas, "NotFrozen");
  });

  it("freezes the picture that was pinned before the claim, even against an operator that repaints mid-burn", async () => {
    // The token IS the operator here, so it can commit from inside its own transferFrom.
    const [owner, , alice] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20Painter")).deploy();
    const tokenAddr = await token.getAddress();
    const canvas = await (await ethers.getContractFactory("FlyonardoCanvas")).deploy(tokenAddr, tokenAddr);
    const addr = await canvas.getAddress();
    await token.setCanvas(addr);
    await token.mint(alice.address, ethers.parseEther("1000000000"));
    await token.connect(alice).approve(addr, ethers.MaxUint256);

    const [shownRoot, shownInput] = roots("shown");
    await token.paint(1, shownRoot, shownInput, 10);
    await token.setSneak(h("sneak"), true);

    await canvas.connect(alice).claim(1, MAXB);
    expect(await token.sneakOk()).to.equal(true); // the repaint really did land mid-burn
    const c = await canvas.canvasOf(1);
    expect([c.strokeRoot, c.inputHash, c.strokes, c.commits]).to.deep.equal([shownRoot, shownInput, 10n, 1n]);
    expect(c.strokeRoot).to.not.equal(h("sneak"));
    // and the sneaked commit is wiped with the rest of the live slot when canvas 2 starts blank
    const live = await canvas.current();
    expect([live.canvasId, live.strokeRoot, live.strokes, live.commits]).to.deep.equal([2n, ethers.ZeroHash, 0n, 0n]);
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
    expect(await canvas.owner()).to.equal(owner.address);
  });

  it("runs canvas after canvas, each frozen at its own last commit", async () => {
    const { canvas, op, alice, bob } = await setup();
    const who = [alice, bob, alice, bob, alice];
    for (let id = 1; id <= who.length; id++) {
      await commit(canvas, op, id, id * 10, "early" + id);
      await commit(canvas, op, id, id * 100, "final" + id);
      await canvas.connect(who[id - 1]).claim(id, MAXB);
      const c = await canvas.canvasOf(id);
      const [r, i] = roots("final" + id);
      expect([c.strokeRoot, c.inputHash, c.strokes, c.commits, c.claimer])
        .to.deep.equal([r, i, BigInt(id * 100), 2n, who[id - 1].address]);
      expect(await canvas.ownerOf(id)).to.equal(who[id - 1].address);
    }
    expect(await canvas.currentCanvas()).to.equal(6n);
    expect(await canvas.totalSupply()).to.equal(5n);
    expect(await canvas.balanceOf(alice.address)).to.equal(3n);
    expect(await canvas.balanceOf(bob.address)).to.equal(2n);
    await expect(canvas.canvasOf(6)).to.be.revertedWithCustomError(canvas, "NotFrozen");
    await expect(canvas.canvasOf(7)).to.be.revertedWithCustomError(canvas, "NotFrozen");
  });
});

describe("owner controls", () => {
  it("setPrice: owner only, non-zero, emits", async () => {
    const { canvas, owner, alice } = await setup();
    await expect(canvas.connect(alice).setPrice(1)).to.be.revertedWithCustomError(canvas, "NotOwner");
    await expect(canvas.connect(owner).setPrice(0)).to.be.revertedWithCustomError(canvas, "ZeroPrice");
    await expect(canvas.connect(owner).setPrice(PRICE * 7n)).to.emit(canvas, "PriceSet").withArgs(PRICE * 7n);
    expect(await canvas.price()).to.equal(PRICE * 7n);
  });

  it("setOperator: owner only, non-zero, emits", async () => {
    const { canvas, owner, alice, bob } = await setup();
    await expect(canvas.connect(alice).setOperator(bob.address)).to.be.revertedWithCustomError(canvas, "NotOwner");
    await expect(canvas.connect(owner).setOperator(ZERO)).to.be.revertedWithCustomError(canvas, "ZeroAddress");
    await expect(canvas.connect(owner).setOperator(bob.address)).to.emit(canvas, "OperatorSet").withArgs(bob.address);
    expect(await canvas.operator()).to.equal(bob.address);
  });

  it("setBaseURI: owner only, emits, and tokenURI follows it", async () => {
    const { canvas, owner, op, alice } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    expect(await canvas.tokenURI(1)).to.equal(""); // no metadata set yet
    await expect(canvas.connect(alice).setBaseURI("x")).to.be.revertedWithCustomError(canvas, "NotOwner");
    await expect(canvas.connect(owner).setBaseURI("https://flyonardo.xyz/canvas/"))
      .to.emit(canvas, "BaseURISet").withArgs("https://flyonardo.xyz/canvas/");
    expect(await canvas.baseURI()).to.equal("https://flyonardo.xyz/canvas/");
    expect(await canvas.tokenURI(1)).to.equal("https://flyonardo.xyz/canvas/1");
    await expect(canvas.tokenURI(2)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
    await canvas.connect(owner).setBaseURI("ipfs://cid/");
    expect(await canvas.tokenURI(1)).to.equal("ipfs://cid/1");
    await canvas.connect(owner).setBaseURI("");
    expect(await canvas.tokenURI(1)).to.equal("");
  });

  it("tokenURI writes multi-digit ids correctly", async () => {
    const { canvas, owner, op, alice } = await setup();
    await canvas.connect(owner).setBaseURI("u/");
    for (let id = 1; id <= 11; id++) await paintAndClaim(canvas, op, alice, id, id, "x" + id);
    for (const id of [1, 9, 10, 11]) expect(await canvas.tokenURI(id)).to.equal(`u/${id}`);
    await expect(canvas.tokenURI(12)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
  });

  it("transferOwnership hands over every owner power at once", async () => {
    const { canvas, owner, alice, bob } = await setup();
    await expect(canvas.connect(alice).transferOwnership(alice.address)).to.be.revertedWithCustomError(canvas, "NotOwner");
    await expect(canvas.connect(owner).transferOwnership(ZERO)).to.be.revertedWithCustomError(canvas, "ZeroAddress");
    await expect(canvas.connect(owner).transferOwnership(alice.address)).to.emit(canvas, "OwnerSet").withArgs(alice.address);
    expect(await canvas.owner()).to.equal(alice.address);
    const gone = [
      () => canvas.connect(owner).setPrice(1),
      () => canvas.connect(owner).setOperator(bob.address),
      () => canvas.connect(owner).setBaseURI("x"),
      () => canvas.connect(owner).transferOwnership(owner.address),
    ];
    for (const call of gone) await expect(call()).to.be.revertedWithCustomError(canvas, "NotOwner");
    await canvas.connect(alice).setPrice(PRICE);
    await canvas.connect(alice).setOperator(bob.address);
    await canvas.connect(alice).setBaseURI("x/");
  });
});

describe("ERC-721", () => {
  it("balanceOf, ownerOf and getApproved reject the queries the standard says they must", async () => {
    const { canvas, op, alice } = await setup();
    await expect(canvas.balanceOf(ZERO)).to.be.revertedWithCustomError(canvas, "ZeroAddress");
    await expect(canvas.ownerOf(1)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
    await expect(canvas.getApproved(1)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
    await expect(canvas.tokenURI(1)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
    await paintAndClaim(canvas, op, alice, 1);
    expect(await canvas.balanceOf(alice.address)).to.equal(1n);
    expect(await canvas.getApproved(1)).to.equal(ZERO);
    await expect(canvas.ownerOf(2)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
  });

  it("approve: owner or operator-for-all only, emits, and clears", async () => {
    const { canvas, op, alice, bob, carol } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    await expect(canvas.connect(bob).approve(bob.address, 1)).to.be.revertedWithCustomError(canvas, "NotAuthorized");
    await expect(canvas.connect(alice).approve(bob.address, 1)).to.emit(canvas, "Approval").withArgs(alice.address, bob.address, 1);
    expect(await canvas.getApproved(1)).to.equal(bob.address);
    // an operator-for-all may re-approve on the holder's behalf
    await canvas.connect(alice).setApprovalForAll(carol.address, true);
    await expect(canvas.connect(carol).approve(carol.address, 1)).to.emit(canvas, "Approval").withArgs(alice.address, carol.address, 1);
    expect(await canvas.getApproved(1)).to.equal(carol.address);
    await canvas.connect(alice).approve(ZERO, 1);
    expect(await canvas.getApproved(1)).to.equal(ZERO);
    await expect(canvas.connect(alice).approve(bob.address, 2)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
  });

  it("setApprovalForAll: emits, toggles, and refuses the zero operator", async () => {
    const { canvas, alice, bob } = await setup();
    expect(await canvas.isApprovedForAll(alice.address, bob.address)).to.equal(false);
    await expect(canvas.connect(alice).setApprovalForAll(ZERO, true)).to.be.revertedWithCustomError(canvas, "ZeroAddress");
    await expect(canvas.connect(alice).setApprovalForAll(bob.address, true))
      .to.emit(canvas, "ApprovalForAll").withArgs(alice.address, bob.address, true);
    expect(await canvas.isApprovedForAll(alice.address, bob.address)).to.equal(true);
    expect(await canvas.isApprovedForAll(bob.address, alice.address)).to.equal(false); // not symmetric
    await expect(canvas.connect(alice).setApprovalForAll(bob.address, false))
      .to.emit(canvas, "ApprovalForAll").withArgs(alice.address, bob.address, false);
    expect(await canvas.isApprovedForAll(alice.address, bob.address)).to.equal(false);
  });

  it("transferFrom moves the canvas, updates balances and spends the approval", async () => {
    const { canvas, op, alice, bob, carol } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    await paintAndClaim(canvas, op, alice, 2);
    await canvas.connect(alice).approve(carol.address, 1);
    GAS["transferFrom (approved)"] = await gasOf(canvas.connect(carol).transferFrom(alice.address, bob.address, 1));
    expect(await canvas.ownerOf(1)).to.equal(bob.address);
    expect(await canvas.balanceOf(alice.address)).to.equal(1n);
    expect(await canvas.balanceOf(bob.address)).to.equal(1n);
    expect(await canvas.getApproved(1)).to.equal(ZERO); // spent by the transfer it authorised
    await expect(canvas.connect(carol).transferFrom(bob.address, carol.address, 1))
      .to.be.revertedWithCustomError(canvas, "NotAuthorized");

    // owner transfer, and an operator-for-all transfer
    await expect(canvas.connect(alice).transferFrom(alice.address, bob.address, 2))
      .to.emit(canvas, "Transfer").withArgs(alice.address, bob.address, 2);
    await canvas.connect(bob).setApprovalForAll(carol.address, true);
    await canvas.connect(carol).transferFrom(bob.address, alice.address, 2);
    expect(await canvas.ownerOf(2)).to.equal(alice.address);
    expect(await canvas.balanceOf(bob.address)).to.equal(1n);
  });

  it("transferFrom rejects a zero recipient, a wrong from, a stranger and a missing token", async () => {
    const { canvas, op, alice, bob } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    await expect(canvas.connect(alice).transferFrom(alice.address, ZERO, 1)).to.be.revertedWithCustomError(canvas, "ZeroAddress");
    await expect(canvas.connect(alice).transferFrom(bob.address, bob.address, 1))
      .to.be.revertedWithCustomError(canvas, "WrongFrom").withArgs(alice.address);
    await expect(canvas.connect(bob).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(canvas, "NotAuthorized");
    await expect(canvas.connect(alice).transferFrom(alice.address, bob.address, 2)).to.be.revertedWithCustomError(canvas, "NoSuchToken");
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
  });

  it("a transfer to yourself is a no-op, not a way to duplicate a balance", async () => {
    const { canvas, op, alice } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    await expect(canvas.connect(alice).transferFrom(alice.address, alice.address, 1))
      .to.emit(canvas, "Transfer").withArgs(alice.address, alice.address, 1);
    expect(await canvas.balanceOf(alice.address)).to.equal(1n);
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
  });

  it("safeTransferFrom calls onERC721Received with the right arguments", async () => {
    const { canvas, op, alice, bob } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    await paintAndClaim(canvas, op, alice, 2);
    const r = await (await ethers.getContractFactory("MockERC721Recipient")).deploy();
    const to = await r.getAddress();

    GAS["safeTransferFrom (contract)"] = await gasOf(
      canvas.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, to, 1));
    expect(await canvas.ownerOf(1)).to.equal(to);
    expect([await r.lastOperator(), await r.lastFrom(), await r.lastTokenId(), await r.lastData(), await r.calls()])
      .to.deep.equal([alice.address, alice.address, 1n, "0x", 1n]);

    // the 4-argument overload forwards its data, and `operator` is the caller, not the holder
    await canvas.connect(alice).setApprovalForAll(bob.address, true);
    await canvas.connect(bob)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, to, 2, "0xc0ffee");
    expect([await r.lastOperator(), await r.lastFrom(), await r.lastTokenId(), await r.lastData(), await r.calls()])
      .to.deep.equal([bob.address, alice.address, 2n, "0xc0ffee", 2n]);
    expect(await canvas.balanceOf(to)).to.equal(2n);
  });

  it("safeTransferFrom to a plain address needs no hook", async () => {
    const { canvas, op, alice, bob } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    GAS["safeTransferFrom (EOA)"] = await gasOf(
      canvas.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1));
    expect(await canvas.ownerOf(1)).to.equal(bob.address);
    await canvas.connect(bob)["safeTransferFrom(address,address,uint256,bytes)"](bob.address, alice.address, 1, "0x1234");
    expect(await canvas.ownerOf(1)).to.equal(alice.address);
  });

  it("safeTransferFrom into a contract that cannot receive reverts, and the canvas stays put", async () => {
    const { canvas, op, alice } = await setup();
    await paintAndClaim(canvas, op, alice, 1);
    const cases = {
      MockNonReceiver: "unsafe",
      MockWrongMagicRecipient: "unsafe",
      MockSilentRevertRecipient: "unsafe",
      MockShortReturnRecipient: "unsafe",
      MockRevertingRecipient: "reason",
    };
    for (const [kind, mode] of Object.entries(cases)) {
      const c = await (await ethers.getContractFactory(kind)).deploy();
      const to = await c.getAddress();
      const call3 = () => canvas.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, to, 1);
      const call4 = () => canvas.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, to, 1, "0xab");
      if (mode === "unsafe") {
        await expect(call3()).to.be.revertedWithCustomError(canvas, "UnsafeRecipient").withArgs(to);
        await expect(call4()).to.be.revertedWithCustomError(canvas, "UnsafeRecipient").withArgs(to);
      } else {
        // a receiver that refuses with a reason keeps its reason
        await expect(call3()).to.be.revertedWith("no thanks");
        await expect(call4()).to.be.revertedWith("no thanks");
      }
      // plain transferFrom is still allowed into any of them: only "safe" promises the hook
      expect(await canvas.ownerOf(1)).to.equal(alice.address);
    }
    const dumb = await (await ethers.getContractFactory("MockNonReceiver")).deploy();
    await canvas.connect(alice).transferFrom(alice.address, await dumb.getAddress(), 1);
    expect(await canvas.ownerOf(1)).to.equal(await dumb.getAddress());
  });

  it("a claimed canvas can change hands without touching its frozen record", async () => {
    const { canvas, op, alice, bob } = await setup();
    const [r, i] = await paintAndClaim(canvas, op, alice, 1, 77, "art");
    await canvas.connect(alice).transferFrom(alice.address, bob.address, 1);
    const c = await canvas.canvasOf(1);
    expect([c.strokeRoot, c.inputHash, c.strokes, c.claimer]).to.deep.equal([r, i, 77n, alice.address]);
    expect(await canvas.ownerOf(1)).to.equal(bob.address);
  });
});

describe("scripts/lib", () => {
  it("mainnetGuard refuses chain 4663 unless CONFIRM_MAINNET=yes", () => {
    const realExit = process.exit;
    const realErr = console.error;
    const before = process.env.CONFIRM_MAINNET;
    let exits = 0;
    process.exit = (code) => {
      exits++;
      throw new Error("exit:" + code);
    };
    console.error = () => {};
    try {
      delete process.env.CONFIRM_MAINNET;
      expect(() => mainnetGuard(4663)).to.throw("exit:1");
      expect(() => mainnetGuard("4663")).to.throw("exit:1");
      expect(() => mainnetGuard(31337)).to.not.throw();
      expect(() => mainnetGuard(1)).to.not.throw();
      process.env.CONFIRM_MAINNET = "y"; // only the exact word gets through
      expect(() => mainnetGuard(4663)).to.throw("exit:1");
      process.env.CONFIRM_MAINNET = "yes";
      expect(() => mainnetGuard(4663)).to.not.throw();
      expect(exits).to.equal(3);
    } finally {
      process.exit = realExit;
      console.error = realErr;
      if (before === undefined) delete process.env.CONFIRM_MAINNET;
      else process.env.CONFIRM_MAINNET = before;
    }
  });

  it("carries the Robinhood Chain and $FLYBRAIN constants the product is deployed against", () => {
    expect(RH_CHAIN_ID).to.equal(4663);
    expect(RH_RPC_URL).to.equal("https://rpc.mainnet.chain.robinhood.com");
    expect(FLYBRAIN).to.equal("0x4eb990547bce4a982432ca88cf5fae7eed1a2d35");
    expect(ethers.isAddress(FLYBRAIN)).to.equal(true);
  });

  after(() => {
    console.log("\n    gas used (tx receipts):");
    for (const [k, v] of Object.entries(GAS)) console.log(`      ${k.padEnd(30)} ${v}`);
  });
});
