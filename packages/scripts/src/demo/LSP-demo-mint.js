#!/usr/bin/env node

// Helper modules
const { getContract, web3 } = require("hardhat");
const { toBN, toWei, fromWei } = web3.utils;
const { MAX_UINT_VAL } = require("@uma/common");

const ERC20 = getContract("ERC20");
const LongShortPair = getContract("LongShortPair");

// Constants to update
const lspAddress = "0xD0d8e0ab5529D1Ec025DE9C2504ef9D3aE076ff8";
const amountOfTokenToMint = toWei(toBN(1));

// Deposit collateral into the LSP Contract to mint tokens.
const mint = async () => {
  const [deployer] = await web3.eth.getAccounts();
  const lspContract = new web3.eth.Contract(
    LongShortPair.abi,
    lspAddress
  );

  console.log("Approving contract to transfer collateral on behalf of user...");
  // Check collateral token associated with LSP contract
  const collateralToken = await lspContract.methods.collateralToken().call()
  const collateral = new web3.eth.Contract(ERC20.abi, collateralToken);

  // The LSP contract needs to be able to transfer collateral on behalf of user.
  await collateral.methods.approve(lspAddress, MAX_UINT_VAL).send({ from: deployer });
  console.log("- Increased LSP allowance to spend collateral");

  // Collateral allowance for the contract address.
  const postAllowance = await collateral.methods.allowance(deployer, lspAddress).call();
  console.log(`- Contract's collateral allowance: ${fromWei(postAllowance.toString())}`);

  console.group("Minting ERC20 LSP tokens...");
  await lspContract.methods.create(amountOfTokenToMint).send({ from: deployer });
  console.log(`- Minted ${fromWei(amountOfTokenToMint)} tokens from LSP contract`);
};

// Run script.
mint()
