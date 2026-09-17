// Deploy FlyonardoCanvas.
//   local:   OPERATOR=0x... npx hardhat run scripts/deploy.js --network localhost
//   mainnet: CONFIRM_MAINNET=yes npx hardhat run scripts/deploy.js --network rh   (owner only)
// Token: TOKEN env, or FLYBRAIN_ADDRESS in ../.env, or the known $FLYBRAIN address. On chain 4663
// it must BE that address - the burn token is immutable, so a typo there is unfixable.
// Operator: OPERATOR env or OPERATOR_ADDRESS in ../.env (public address, the painter service).
// Signer: hardhat account #0 on local chains, FLY_RH_SECRET from ../.env elsewhere.
// Price starts at the contract's INITIAL_PRICE (100,000e18); scripts/set-price.js changes it.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { readEnv, mainnetGuard, signerFor, deploymentFile, FLYBRAIN, RH_CHAIN_ID, LOCAL_CHAINS } = require("./lib");

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  mainnetGuard(chainId);
  const local = LOCAL_CHAINS.has(chainId);
  const env = readEnv();

  let tokenAddr = process.env.TOKEN || env.FLYBRAIN_ADDRESS || FLYBRAIN;
  if (tokenAddr === "mock") {
    if (!local) throw new Error("TOKEN=mock is local only");
    const m = await (await ethers.getContractFactory("MockERC20")).deploy("Mock FlyBrain", "MFLY");
    await m.waitForDeployment();
    tokenAddr = await m.getAddress();
    console.log("deployed MockERC20", tokenAddr);
  }
  if (!ethers.isAddress(tokenAddr)) throw new Error("TOKEN / FLYBRAIN_ADDRESS is not an address");
  if (chainId === RH_CHAIN_ID && tokenAddr.toLowerCase() !== FLYBRAIN.toLowerCase()) {
    throw new Error(`refusing to bind chain ${RH_CHAIN_ID} to ${tokenAddr}; $FLYBRAIN is ${FLYBRAIN}`);
  }
  if ((await ethers.provider.getCode(tokenAddr)) === "0x") throw new Error(`no contract at token ${tokenAddr}`);

  const operator = process.env.OPERATOR || env.OPERATOR_ADDRESS;
  if (!operator || !ethers.isAddress(operator)) throw new Error("OPERATOR / OPERATOR_ADDRESS missing");

  const signer = await signerFor(ethers, chainId);
  const bal = await ethers.provider.getBalance(signer.address);
  console.log(`chain ${chainId}  deployer ${signer.address}  balance ${ethers.formatEther(bal)}`);
  console.log(`token ${tokenAddr}  operator ${operator}`);

  const F = await ethers.getContractFactory("FlyonardoCanvas", signer);
  const canvas = await F.deploy(tokenAddr, operator);
  const tx = canvas.deploymentTransaction();
  const rc = await tx.wait();
  const address = await canvas.getAddress();

  // read back
  const check = {
    name: await canvas.name(),
    symbol: await canvas.symbol(),
    owner: await canvas.owner(),
    operator: await canvas.operator(),
    token: await canvas.token(),
    price: (await canvas.price()).toString(),
    currentCanvas: Number(await canvas.currentCanvas()),
  };
  if (
    check.token.toLowerCase() !== tokenAddr.toLowerCase() ||
    check.operator.toLowerCase() !== operator.toLowerCase() ||
    check.owner.toLowerCase() !== signer.address.toLowerCase() ||
    check.price !== (await canvas.INITIAL_PRICE()).toString() ||
    check.currentCanvas !== Number(await canvas.FIRST_CANVAS())
  ) {
    throw new Error("read-back mismatch");
  }

  const out = {
    chainId,
    address,
    txHash: tx.hash,
    blockNumber: rc.blockNumber,
    gasUsed: rc.gasUsed.toString(),
    deployer: signer.address,
    ...check,
    priceTokens: ethers.formatUnits(check.price, 18),
    compiler: { solc: "0.8.24", optimizerRuns: 200, evmVersion: "shanghai" },
    deployedAt: new Date().toISOString(),
  };
  if (hre.network.name === "hardhat") {
    console.log(`FlyonardoCanvas ${address}  gas ${rc.gasUsed}  (in-memory chain, deployments file not written)`);
    return;
  }
  const file = deploymentFile(chainId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`FlyonardoCanvas ${address}  gas ${rc.gasUsed}  -> ${path.relative(process.cwd(), file)}`);
  console.log(`price ${out.priceTokens} $FLYBRAIN per canvas; set baseURI before the first claim`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
