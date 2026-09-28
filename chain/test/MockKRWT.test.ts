import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { zeroAddress } from "viem";

async function deployToken() {
    const [deployer, alice, bob] = await hre.viem.getWalletClients();
    const token = await hre.viem.deployContract("MockKRWT");
    return { token, deployer, alice, bob };
}

describe("MockKRWT", function () {
    it("D-05: is 'Mock KRW Token' (mKRW) with 0 decimals so 1 token = 1 KRW", async function () {
        const { token } = await loadFixture(deployToken);

        expect(await token.read.name()).to.equal("Mock KRW Token");
        expect(await token.read.symbol()).to.equal("mKRW");
        expect(await token.read.decimals()).to.equal(0);
        expect(await token.read.totalSupply()).to.equal(0n);
    });

    it("lets any account mint to any address (test token)", async function () {
        const { token, alice, bob } = await loadFixture(deployToken);

        await token.write.mint([bob.account.address, 200_000n], { account: alice.account });

        expect(await token.read.balanceOf([bob.account.address])).to.equal(200_000n);
        expect(await token.read.totalSupply()).to.equal(200_000n);
    });

    it("boundary: minting 1 unit adds exactly 1", async function () {
        const { token, alice } = await loadFixture(deployToken);

        await token.write.mint([alice.account.address, 1n]);

        expect(await token.read.balanceOf([alice.account.address])).to.equal(1n);
    });

    it("rejects minting to the zero address", async function () {
        const { token } = await loadFixture(deployToken);

        await expect(token.write.mint([zeroAddress, 1n])).to.be.rejectedWith("ERC20InvalidReceiver");
    });
});
