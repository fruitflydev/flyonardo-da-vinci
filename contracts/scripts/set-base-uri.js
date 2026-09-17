// Point tokenURI at the painter's metadata endpoint. Owner only, and re-runnable: the
// canvases themselves are frozen on chain, so only where their metadata is served can move.
//
//   local:   npx hardhat run scripts/set-base-uri.js --network localhost
//   live:    CONFIRM_MAINNET=yes BASE_URI=https://host/nft/ npx hardhat run scripts/set-base-uri.js --network rh
const hre = require("hardhat");
const { mainnetGuard, signerFor, deploymentFile } = require("./lib");

const DEFAULT_BASE = "https://painter-production.up.railway.app/nft/";

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  mainnetGuard(chainId);
  const dep = JSON.parse(require("fs").readFileSync(deploymentFile(chainId), "utf8"));
  const base = process.env.BASE_URI || DEFAULT_BASE;
  if (!/^https:\/\/.+\/$/.test(base)) throw new Error("BASE_URI must be https and end with /");

  const signer = await signerFor(ethers, chainId);
  const c = await ethers.getContractAt("FlyonardoCanvas", dep.address, signer);
  const owner = await c.owner();
  if (owner.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error(`signer ${await signer.getAddress()} is not the owner ${owner}`);
  }
  console.log(`chain ${chainId}  contract ${dep.address}  base "${base}"`);
  const tx = await c.setBaseURI(base);
  const r = await tx.wait();
  console.log(`setBaseURI in ${r.hash} (gas ${r.gasUsed})`);
  console.log(`tokenURI(1) -> ${await c.tokenURI(1).catch(() => "(canvas 1 not claimed yet)")}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
