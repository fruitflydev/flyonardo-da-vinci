require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-ethers");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
const { readEnv, RH_CHAIN_ID, RH_RPC_URL } = require("./scripts/lib");

// Use solcjs from npm (solc@0.8.24) instead of downloading a native compiler.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    const compilerPath = path.join(__dirname, "node_modules", "solc", "soljson.js");
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: "0.8.24+commit.e11b9ed9" };
  }
  return runSuper();
});

const env = readEnv();

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" },
  },
  mocha: { timeout: 120000 },
  networks: {
    // GUARD_TEST_CHAIN_ID lets the in-memory chain pretend to be 4663 to test the mainnet guard offline.
    hardhat: {
      ...(process.env.GUARD_TEST_CHAIN_ID ? { chainId: Number(process.env.GUARD_TEST_CHAIN_ID) } : {}),
    },
    localhost: { url: "http://127.0.0.1:8545" },
    // No accounts here: scripts build the signer from ../.env themselves, behind the chain-4663 guard.
    rh: { url: env.RH_RPC_URL || RH_RPC_URL, chainId: RH_CHAIN_ID },
  },
};
