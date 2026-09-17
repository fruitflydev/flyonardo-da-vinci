// setPrice on FlyonardoCanvas: what a claim burns from here on.
//   local:   PRICE=50000 npx hardhat run scripts/set-price.js --network localhost
//   mainnet: CONFIRM_MAINNET=yes PRICE=50000 npx hardhat run scripts/set-price.js --network rh
// CANVAS env or deployments/<chainId>.json; PRICE in whole $FLYBRAIN (18 decimals) or PRICE_WEI.
// A price change never touches a pending claim: claim(canvasId, maxBurn) reverts rather than
// overcharge someone who was shown the old price.
const fs = require("fs");
const hre = require("hardhat");
const { mainnetGuard, signerFor, deploymentFile } = require("./lib");

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  mainnetGuard(chainId);

  const file = deploymentFile(chainId);
  const address = process.env.CANVAS || (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).address);
  if (!address || !ethers.isAddress(address)) throw new Error("no CANVAS and no deployments file");

  let price;
  if (process.env.PRICE_WEI) price = BigInt(process.env.PRICE_WEI);
  else if (process.env.PRICE) price = ethers.parseUnits(process.env.PRICE, 18);
  else throw new Error("set PRICE (whole $FLYBRAIN) or PRICE_WEI");
  if (price <= 0n) throw new Error("price must be > 0");

  const signer = await signerFor(ethers, chainId);
  const canvas = await ethers.getContractAt("FlyonardoCanvas", address, signer);
  const owner = await canvas.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not owner ${owner}`);
  }

  const before = await canvas.price();
  if (before === price) {
    console.log(`price already ${ethers.formatUnits(price, 18)} $FLYBRAIN; nothing to do`);
    return;
  }
  console.log(`chain ${chainId} canvas ${address}: ${ethers.formatUnits(before, 18)} -> ${ethers.formatUnits(price, 18)} $FLYBRAIN`);
  const tx = await canvas.setPrice(price);
  const rc = await tx.wait();
  const after = await canvas.price();
  if (after !== price) throw new Error("read-back mismatch");
  console.log(`setPrice tx ${tx.hash} gas ${rc.gasUsed}; price() = ${after}`);

  if (fs.existsSync(file)) {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d.address.toLowerCase() === address.toLowerCase()) {
      Object.assign(d, { price: after.toString(), priceTokens: ethers.formatUnits(after, 18), setPriceTx: tx.hash });
      fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    }
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
