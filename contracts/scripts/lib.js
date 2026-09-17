// Shared helpers for the deploy scripts. Never log values read from .env except public addresses.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(ROOT, ".env");

// Robinhood Chain (Nitro EVM): ~0.1s blocks, gas ~0.055 gwei.
const RH_CHAIN_ID = 4663;
const RH_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
// $FLYBRAIN, 18 decimals, 1,000,000,000 supply. The burn token is immutable in the contract, so
// this address is the one thing a deploy must not get wrong.
const FLYBRAIN = "0x4eb990547bce4a982432ca88cf5fae7eed1a2d35";
const LOCAL_CHAINS = new Set([31337, 1337]);

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function mainnetGuard(chainId) {
  if (Number(chainId) === RH_CHAIN_ID && process.env.CONFIRM_MAINNET !== "yes") {
    console.error(`Refusing chain ${RH_CHAIN_ID} (Robinhood Chain mainnet). Set CONFIRM_MAINNET=yes to proceed.`);
    process.exit(1);
  }
}

/// Hardhat account #0 on a local chain, otherwise the FLY_RH_SECRET key from ../.env. The key is
/// only ever compared against FLY_RH_ADDRESS (public) so a wrong .env fails before it spends gas.
function signerFor(ethers, chainId) {
  if (LOCAL_CHAINS.has(Number(chainId))) return ethers.getSigners().then(([s]) => s);
  const env = readEnv();
  if (!env.FLY_RH_SECRET) throw new Error(`FLY_RH_SECRET missing in ${ENV_PATH}`);
  const signer = new ethers.Wallet(env.FLY_RH_SECRET, ethers.provider);
  if (env.FLY_RH_ADDRESS && signer.address.toLowerCase() !== env.FLY_RH_ADDRESS.toLowerCase()) {
    throw new Error("FLY_RH_SECRET does not match FLY_RH_ADDRESS");
  }
  return Promise.resolve(signer);
}

/// deployments/<chainId>.json, or <chainId>-<tag>.json when DEPLOY_TAG is set, so a throwaway
/// deploy (one bound to a test coin, say) never overwrites the real record.
function deploymentFile(chainId) {
  const tag = process.env.DEPLOY_TAG ? `-${process.env.DEPLOY_TAG.replace(/[^a-z0-9]/gi, "")}` : "";
  return path.join(__dirname, "..", "deployments", `${chainId}${tag}.json`);
}

module.exports = { ROOT, ENV_PATH, RH_CHAIN_ID, RH_RPC_URL, FLYBRAIN, LOCAL_CHAINS, readEnv, mainnetGuard, signerFor, deploymentFile };
