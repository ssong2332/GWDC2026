import { expect } from "chai";
import hre from "hardhat";

describe("contract test harness smoke", function () {
    it("exposes the in-process Hardhat network through hardhat-viem", async function () {
        const publicClient = await hre.viem.getPublicClient();
        const walletClients = await hre.viem.getWalletClients();

        expect(await publicClient.getChainId()).to.equal(31337);
        expect(walletClients.length).to.be.at.least(3);
        const balance = await publicClient.getBalance({ address: walletClients[0].account.address });
        expect(balance > 0n).to.equal(true);
    });
});
