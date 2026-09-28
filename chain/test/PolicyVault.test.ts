import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { getAddress, zeroAddress, type Address } from "viem";
import {
    DAY,
    FEE_BPS,
    FLAG,
    MINUTE,
    POLICY_FIELD,
    REASON,
    STATUS,
    alignToNextDay,
    balances,
    buildPolicy,
    deployFundedVault,
    expectRevert,
    hashOf,
    ownerCall,
    ownerToggle,
    setPolicy,
    simulateSpend,
    spend,
    type VaultFixture,
} from "./helpers/vault";

async function ready(): Promise<VaultFixture> {
    const f = await loadFixture(deployFundedVault);
    await alignToNextDay();
    return f;
}

async function readyWithPolicy(overrides = {}) {
    const f = await ready();
    const { policy } = await setPolicy(f, overrides);
    return { f, policy };
}

function policySnapshot(s: Record<string, unknown>) {
    const { blockTimestamp: _t, blockNumber: _n, ...rest } = s;
    return rest;
}

describe("PolicyVault", function () {
    describe("constructor", function () {
        it("stores token, owner, agent, fee recipient and fee bps as immutables; starts with no policy", async function () {
            const f = await loadFixture(deployFundedVault);

            expect(getAddress(await f.vault.read.token())).to.equal(getAddress(f.token.address));
            expect(getAddress(await f.vault.read.owner())).to.equal(getAddress(f.owner.account.address));
            expect(getAddress(await f.vault.read.agent())).to.equal(getAddress(f.agent.account.address));
            expect(getAddress(await f.vault.read.feeRecipient())).to.equal(getAddress(f.feeRecipient.account.address));
            expect(await f.vault.read.feeBps()).to.equal(FEE_BPS);
            const s = await f.vault.read.getState();
            expect(s.policyVersion).to.equal(0n);
            expect(s.paused).to.equal(false);
            expect(s.feeBps).to.equal(FEE_BPS);
            expect(s.vaultBalance).to.equal(1_000_000n);
        });

        it("boundary: accepts feeBps = 1000 (10%) and rejects 1001 with InvalidFee", async function () {
            const [agent, owner, fee] = await hre.viem.getWalletClients();
            const token = await hre.viem.deployContract("MockKRWT");
            const args = (bps: number) =>
                [token.address, owner.account.address, agent.account.address, fee.account.address, bps] as const;

            const ok = await hre.viem.deployContract("PolicyVault", args(1000));
            expect(await ok.read.feeBps()).to.equal(1000);
            await expect(hre.viem.deployContract("PolicyVault", args(1001))).to.be.rejectedWith("InvalidFee");
        });

        it("rejects a zero address for token, owner, agent or fee recipient with ZeroAddress", async function () {
            const [agent, owner, fee] = await hre.viem.getWalletClients();
            const token = await hre.viem.deployContract("MockKRWT");
            const good: [Address, Address, Address, Address] = [
                token.address,
                owner.account.address,
                agent.account.address,
                fee.account.address,
            ];
            for (let i = 0; i < 4; i++) {
                const bad = [...good];
                bad[i] = zeroAddress;
                await expect(
                    hre.viem.deployContract("PolicyVault", [bad[0], bad[1], bad[2], bad[3], FEE_BPS]),
                    `slot ${i}`,
                ).to.be.rejectedWith("ZeroAddress");
            }
        });
    });

    describe("setPolicy", function () {
        it("owner registers a policy: PolicySet carries every field and the evidence hash; state reflects it", async function () {
            const f = await ready();
            const evidence = hashOf("policy-v1");

            const { policy, logs } = await setPolicy(f, {}, evidence);

            expect(logs).to.have.length(1);
            expect(logs[0].eventName).to.equal("PolicySet");
            expect(logs[0].args).to.deep.equal({
                policyVersion: 1n,
                by: getAddress(f.owner.account.address),
                budget: 200_000n,
                approvalThreshold: 50_000n,
                expiresAt: policy.expiresAt,
                maxPerMinute: 3,
                maxPerDay: 20,
                merchants: policy.merchants.map((m) => getAddress(m)),
                evidenceHash: evidence,
            });
            const s = await f.vault.read.getState();
            expect(s.policyVersion).to.equal(1n);
            expect(s.budget).to.equal(200_000n);
            expect(s.approvalThreshold).to.equal(50_000n);
            expect(s.expiresAt).to.equal(policy.expiresAt);
            expect(s.maxPerMinute).to.equal(3);
            expect(s.maxPerDay).to.equal(20);
            expect(s.spent).to.equal(0n);
            expect(s.reserved).to.equal(0n);
            expect(s.merchants.map((m: Address) => getAddress(m))).to.deep.equal(policy.merchants.map((m) => getAddress(m)));
            expect(await f.vault.read.isAllowedMerchant([f.merchantA.account.address])).to.equal(true);
            expect(await f.vault.read.isAllowedMerchant([f.merchantX.account.address])).to.equal(false);
            expect(await f.vault.read.remainingBudget()).to.equal(200_000n);
        });

        it("replacing a policy bumps the version, resets spent and replaces the merchant list", async function () {
            const { f } = await readyWithPolicy();
            await spend(f, { requestId: hashOf("r1"), merchant: f.merchantA.account.address, amount: 10_000n });
            expect((await f.vault.read.getState()).spent).to.equal(10_100n);

            await setPolicy(f, { budget: 90_000n, merchants: [f.merchantX.account.address] }, hashOf("policy-v2"));

            const s = await f.vault.read.getState();
            expect(s.policyVersion).to.equal(2n);
            expect(s.spent).to.equal(0n);
            expect(s.budget).to.equal(90_000n);
            expect(await f.vault.read.isAllowedMerchant([f.merchantA.account.address])).to.equal(false);
            expect(await f.vault.read.isAllowedMerchant([f.merchantB.account.address])).to.equal(false);
            expect(await f.vault.read.isAllowedMerchant([f.merchantX.account.address])).to.equal(true);
        });

        it("boundary: accepts threshold = budget, maxPerDay = maxPerMinute and exactly 20 merchants", async function () {
            const f = await ready();
            const wallets = await hre.viem.getWalletClients();
            const twenty = wallets.slice(0, 20).map((w) => w.account.address);
            expect(twenty).to.have.length(20);

            await setPolicy(f, { budget: 1n, approvalThreshold: 1n, maxPerMinute: 5, maxPerDay: 5, merchants: twenty });

            const s = await f.vault.read.getState();
            expect(s.approvalThreshold).to.equal(1n);
            expect(s.maxPerDay).to.equal(5);
            expect(s.merchants).to.have.length(20);
        });

        it("rejects invalid fields with InvalidPolicy(field) and keeps the old policy", async function () {
            const f = await ready();
            const addrA = f.merchantA.account.address;
            const twentyOne = Array.from({ length: 21 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
            const now = BigInt(await time.latest());
            const cases: [string, Record<string, unknown>, number][] = [
                ["budget 0", { budget: 0n, approvalThreshold: 0n }, POLICY_FIELD.BUDGET],
                ["threshold > budget", { budget: 100n, approvalThreshold: 101n }, POLICY_FIELD.APPROVAL_THRESHOLD],
                ["expiresAt in the past", { expiresAt: now - 1n }, POLICY_FIELD.EXPIRES_AT],
                ["maxPerMinute 0", { maxPerMinute: 0, maxPerDay: 20 }, POLICY_FIELD.MAX_PER_MINUTE],
                ["maxPerDay < maxPerMinute", { maxPerMinute: 4, maxPerDay: 3 }, POLICY_FIELD.MAX_PER_DAY],
                ["no merchants", { merchants: [] }, POLICY_FIELD.MERCHANTS],
                ["21 merchants", { merchants: twentyOne }, POLICY_FIELD.MERCHANTS],
                ["zero-address merchant", { merchants: [addrA, zeroAddress] }, POLICY_FIELD.MERCHANTS],
                ["duplicate merchant", { merchants: [addrA, addrA] }, POLICY_FIELD.MERCHANTS],
            ];
            for (const [label, overrides, field] of cases) {
                const p = await buildPolicy(f, overrides);
                await expectRevert(
                    f.vault.write.setPolicy([p, hashOf(label)], { account: f.owner.account }),
                    "InvalidPolicy",
                    [field],
                );
            }
            expect((await f.vault.read.getState()).policyVersion).to.equal(0n);
        });

        it("boundary: expiresAt equal to the mining block timestamp is rejected (must be strictly later)", async function () {
            const f = await ready();
            const t = BigInt(await time.latest()) + 10n;
            const p = await buildPolicy(f, { expiresAt: t });
            await time.setNextBlockTimestamp(t);

            await expectRevert(
                f.vault.write.setPolicy([p, hashOf("edge")], { account: f.owner.account, gas: 1_000_000n }),
                "InvalidPolicy",
                [POLICY_FIELD.EXPIRES_AT],
            );
        });

        it("rejects setPolicy while a pending request exists (PendingExists), allows it after reject", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("pending-1");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });
            const p = await buildPolicy(f, { budget: 300_000n });

            await expectRevert(
                f.vault.write.setPolicy([p, hashOf("v2")], { account: f.owner.account }),
                "PendingExists",
            );

            await ownerCall(f, "reject", rid, hashOf("reject"));
            await setPolicy(f, { budget: 300_000n }, hashOf("v2"));
            expect((await f.vault.read.getState()).policyVersion).to.equal(2n);
        });
    });

    describe("F-03 ② agent cannot change rules", function () {
        it("agent and strangers calling owner-only functions fail with NotOwner and the policy is unchanged", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("pending");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });
            const before = policySnapshot(await f.vault.read.getState());
            const p = await buildPolicy(f, { budget: 999_999n });

            for (const who of [f.agent, f.stranger]) {
                const account = who.account;
                await expectRevert(f.vault.write.setPolicy([p, hashOf("x")], { account }), "NotOwner");
                await expectRevert(f.vault.write.pause([hashOf("x")], { account }), "NotOwner");
                await expectRevert(f.vault.write.unpause([hashOf("x")], { account }), "NotOwner");
                await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account }), "NotOwner");
                await expectRevert(f.vault.write.reject([rid, hashOf("x")], { account }), "NotOwner");
            }

            expect(policySnapshot(await f.vault.read.getState())).to.deep.equal(before);
            expect((await f.vault.read.getPending([rid])).status).to.equal(STATUS.PENDING);
        });
    });

    describe("spend — input errors revert (not recorded)", function () {
        it("only the agent may call spend (NotAgent)", async function () {
            const { f } = await readyWithPolicy();
            for (const who of [f.owner, f.stranger]) {
                await expectRevert(
                    f.vault.write.spend([hashOf("r"), f.merchantA.account.address, 1_000n, false, hashOf("e")], {
                        account: who.account,
                    }),
                    "NotAgent",
                );
            }
        });

        it("amount 0 reverts InvalidAmount; zero merchant reverts ZeroAddress", async function () {
            const { f } = await readyWithPolicy();
            const account = f.agent.account;
            await expectRevert(
                f.vault.write.spend([hashOf("r0"), f.merchantA.account.address, 0n, false, hashOf("e")], { account }),
                "InvalidAmount",
            );
            await expectRevert(
                f.vault.write.spend([hashOf("r1"), zeroAddress, 1_000n, false, hashOf("e")], { account }),
                "ZeroAddress",
            );
        });

        it("a requestId can be used once, even if the first attempt was blocked (DuplicateRequest)", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("dup");
            await spend(f, { requestId: rid, merchant: f.merchantX.account.address, amount: 1_000n });

            await expectRevert(
                f.vault.write.spend([rid, f.merchantA.account.address, 1_000n, false, hashOf("e")], {
                    account: f.agent.account,
                }),
                "DuplicateRequest",
            );
        });
    });

    describe("F-03 ① ③ spend within limits, remaining budget read", function () {
        it("F-03 ①: executes a within-limit spend — merchant +amount, fee to recipient, remaining −(amount+fee), SpendExecuted", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("ok-1");
            const evidence = hashOf("ev-ok-1");
            const b0 = await balances(f);
            const req = { requestId: rid, merchant: f.merchantA.account.address, amount: 30_000n, evidenceHash: evidence };

            expect(await simulateSpend(f, req)).to.equal(true);
            const { logs, receipt } = await spend(f, req);

            expect(receipt.status).to.equal("success");
            const b1 = await balances(f);
            expect(b1.merchantA - b0.merchantA).to.equal(30_000n);
            expect(b1.feeRecipient - b0.feeRecipient).to.equal(300n);
            expect(b0.vault - b1.vault).to.equal(30_300n);
            expect(await f.vault.read.remainingBudget()).to.equal(169_700n);
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendExecuted"]);
            expect(logs[0].args).to.deep.equal({
                requestId: rid,
                merchant: getAddress(f.merchantA.account.address),
                amount: 30_000n,
                fee: 300n,
                policyVersion: 1n,
                viaApproval: false,
                evidenceHash: evidence,
            });
        });

        it("F-03 ③: remainingBudget() equals budget − spent − reserved from getState()", async function () {
            const { f } = await readyWithPolicy();
            await spend(f, { requestId: hashOf("a"), merchant: f.merchantA.account.address, amount: 30_000n });
            await spend(f, { requestId: hashOf("b"), merchant: f.merchantB.account.address, amount: 60_000n });

            const s = await f.vault.read.getState();
            expect(s.spent).to.equal(30_300n);
            expect(s.reserved).to.equal(60_600n);
            expect(await f.vault.read.remainingBudget()).to.equal(s.budget - s.spent - s.reserved);
            expect(await f.vault.read.remainingBudget()).to.equal(109_100n);
        });

        it("F-03 ③ boundary: remainingBudget() is 0 before any policy exists", async function () {
            const f = await ready();
            expect(await f.vault.read.remainingBudget()).to.equal(0n);
        });
    });

    describe("F-03 ④ expiry", function () {
        it("boundary: one second before expiresAt executes; at expiresAt it is blocked EXPIRED with no token movement", async function () {
            const { f, policy } = await readyWithPolicy();
            const merchant = f.merchantA.account.address;

            await time.setNextBlockTimestamp(policy.expiresAt - 1n);
            const before = await spend(f, { requestId: hashOf("t-1"), merchant, amount: 1_000n });
            expect(before.logs.map((l) => l.eventName)).to.deep.equal(["SpendExecuted"]);

            const b0 = await balances(f);
            const evidence = hashOf("ev-expired");
            await time.setNextBlockTimestamp(policy.expiresAt);
            const { logs, receipt } = await spend(f, { requestId: hashOf("t0"), merchant, amount: 1_000n, evidenceHash: evidence });

            expect(receipt.status).to.equal("success");
            expect(await balances(f)).to.deep.equal(b0);
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendBlocked"]);
            expect(logs[0].args).to.deep.equal({
                requestId: hashOf("t0"),
                merchant: getAddress(merchant),
                amount: 1_000n,
                fee: 10n,
                reason: REASON.EXPIRED,
                policyVersion: 1n,
                evidenceHash: evidence,
            });
        });
    });

    describe("F-04 approval queue", function () {
        it("F-04 ①: amount above the threshold becomes pending (flag OVER_THRESHOLD), reserves amount+fee, moves no tokens", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("big");
            const evidence = hashOf("ev-big");
            const b0 = await balances(f);
            const req = { requestId: rid, merchant: f.merchantB.account.address, amount: 50_001n, evidenceHash: evidence };

            expect(await simulateSpend(f, req)).to.equal(false);
            const { logs } = await spend(f, req);

            expect(await balances(f)).to.deep.equal(b0);
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendPending"]);
            expect(logs[0].args).to.deep.equal({
                requestId: rid,
                merchant: getAddress(f.merchantB.account.address),
                amount: 50_001n,
                fee: 500n,
                flags: FLAG.OVER_THRESHOLD,
                policyVersion: 1n,
                evidenceHash: evidence,
            });
            const p = await f.vault.read.getPending([rid]);
            expect(p).to.deep.equal({
                merchant: getAddress(f.merchantB.account.address),
                amount: 50_001n,
                fee: 500n,
                policyVersion: 1n,
                flags: FLAG.OVER_THRESHOLD,
                status: STATUS.PENDING,
                evidenceHash: evidence,
            });
            const s = await f.vault.read.getState();
            expect(s.reserved).to.equal(50_501n);
            expect(s.pendingCount).to.equal(1);
            expect(await f.vault.read.remainingBudget()).to.equal(200_000n - 50_501n);
        });

        it("F-04 ① boundary: amount equal to the threshold executes immediately", async function () {
            const { f } = await readyWithPolicy();
            const { logs } = await spend(f, { requestId: hashOf("eq"), merchant: f.merchantA.account.address, amount: 50_000n });
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendExecuted"]);
        });

        it("F-04 ④ (contract side): agentReviewRequest=true turns an executable spend into pending (flag 2); both reasons give flags 3", async function () {
            const { f } = await readyWithPolicy();

            const r1 = await spend(f, {
                requestId: hashOf("ai"),
                merchant: f.merchantA.account.address,
                amount: 15_000n,
                agentReviewRequest: true,
            });
            const r2 = await spend(f, {
                requestId: hashOf("ai+big"),
                merchant: f.merchantA.account.address,
                amount: 60_000n,
                agentReviewRequest: true,
            });

            expect(r1.logs[0].eventName).to.equal("SpendPending");
            expect(r1.logs[0].args.flags).to.equal(FLAG.AGENT_REVIEW_REQUEST);
            expect(r2.logs[0].eventName).to.equal("SpendPending");
            expect(r2.logs[0].args.flags).to.equal(FLAG.OVER_THRESHOLD | FLAG.AGENT_REVIEW_REQUEST);
            expect((await f.vault.read.getState()).pendingCount).to.equal(2);
        });

        it("F-04 ④ (contract side): agentReviewRequest never loosens a block — a blocked request stays blocked", async function () {
            const { f } = await readyWithPolicy();
            const { logs } = await spend(f, {
                requestId: hashOf("x+ai"),
                merchant: f.merchantX.account.address,
                amount: 1_000n,
                agentReviewRequest: true,
            });
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendBlocked"]);
            expect(logs[0].args.reason).to.equal(REASON.MERCHANT_NOT_ALLOWED);
            expect((await f.vault.read.getState()).pendingCount).to.equal(0);
        });

        it("F-04 ②: owner approve executes the pending spend — Approved(owner) then SpendExecuted(viaApproval, original evidence)", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("to-approve");
            const requestEvidence = hashOf("ev-request");
            const approvalEvidence = hashOf("ev-approval");
            await spend(f, { requestId: rid, merchant: f.merchantB.account.address, amount: 60_000n, evidenceHash: requestEvidence });
            const b0 = await balances(f);

            const { logs } = await ownerCall(f, "approve", rid, approvalEvidence);

            expect(logs.map((l) => l.eventName)).to.deep.equal(["Approved", "SpendExecuted"]);
            expect(logs[0].args).to.deep.equal({
                requestId: rid,
                approver: getAddress(f.owner.account.address),
                evidenceHash: approvalEvidence,
            });
            expect(logs[1].args).to.deep.equal({
                requestId: rid,
                merchant: getAddress(f.merchantB.account.address),
                amount: 60_000n,
                fee: 600n,
                policyVersion: 1n,
                viaApproval: true,
                evidenceHash: requestEvidence,
            });
            const b1 = await balances(f);
            expect(b1.merchantB - b0.merchantB).to.equal(60_000n);
            expect(b1.feeRecipient - b0.feeRecipient).to.equal(600n);
            const s = await f.vault.read.getState();
            expect(s.reserved).to.equal(0n);
            expect(s.spent).to.equal(60_600n);
            expect(s.pendingCount).to.equal(0);
            expect((await f.vault.read.getPending([rid])).status).to.equal(STATUS.APPROVED);
            expect(await f.vault.read.remainingBudget()).to.equal(139_400n);
        });

        it("F-04 ③: a non-owner approve fails (NotOwner) and the item stays pending", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("p");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });

            await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account: f.agent.account }), "NotOwner");
            await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account: f.stranger.account }), "NotOwner");

            expect((await f.vault.read.getPending([rid])).status).to.equal(STATUS.PENDING);
            expect((await f.vault.read.getState()).reserved).to.equal(60_600n);
        });

        it("approve fails with PendingNotFound for unknown ids and for already-approved ids", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("once");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });
            await ownerCall(f, "approve", rid, hashOf("a1"));

            await expectRevert(f.vault.write.approve([hashOf("nope"), hashOf("x")], { account: f.owner.account }), "PendingNotFound");
            await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account: f.owner.account }), "PendingNotFound");
        });

        it("approve fails with VaultIsPaused while paused and PolicyExpired after expiry", async function () {
            const { f, policy } = await readyWithPolicy();
            const rid = hashOf("p");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });

            await ownerToggle(f, "pause", hashOf("pause"));
            await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account: f.owner.account }), "VaultIsPaused");
            await ownerToggle(f, "unpause", hashOf("unpause"));

            await time.increaseTo(policy.expiresAt);
            await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account: f.owner.account }), "PolicyExpired");
            expect((await f.vault.read.getPending([rid])).status).to.equal(STATUS.PENDING);
        });
    });

    describe("D-08 reject", function () {
        it("owner reject releases the reservation, marks the item rejected, emits Rejected, moves no tokens", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("to-reject");
            const evidence = hashOf("ev-reject");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });
            const b0 = await balances(f);

            const { logs } = await ownerCall(f, "reject", rid, evidence);

            expect(logs.map((l) => l.eventName)).to.deep.equal(["Rejected"]);
            expect(logs[0].args).to.deep.equal({
                requestId: rid,
                approver: getAddress(f.owner.account.address),
                evidenceHash: evidence,
            });
            expect(await balances(f)).to.deep.equal(b0);
            const s = await f.vault.read.getState();
            expect(s.reserved).to.equal(0n);
            expect(s.spent).to.equal(0n);
            expect(s.pendingCount).to.equal(0);
            expect((await f.vault.read.getPending([rid])).status).to.equal(STATUS.REJECTED);
            expect(await f.vault.read.remainingBudget()).to.equal(200_000n);
        });

        it("reject/approve of a rejected item fail with PendingNotFound; non-owner reject fails with NotOwner", async function () {
            const { f } = await readyWithPolicy();
            const rid = hashOf("r");
            await spend(f, { requestId: rid, merchant: f.merchantA.account.address, amount: 60_000n });
            await expectRevert(f.vault.write.reject([rid, hashOf("x")], { account: f.agent.account }), "NotOwner");
            await ownerCall(f, "reject", rid, hashOf("r1"));

            await expectRevert(f.vault.write.reject([rid, hashOf("x")], { account: f.owner.account }), "PendingNotFound");
            await expectRevert(f.vault.write.approve([rid, hashOf("x")], { account: f.owner.account }), "PendingNotFound");
        });
    });

    describe("F-05 pause", function () {
        it("F-05 ①: owner pause sets paused and VaultPaused records the owner as sender", async function () {
            const { f } = await readyWithPolicy();
            const evidence = hashOf("ev-pause");

            const { logs } = await ownerToggle(f, "pause", evidence);

            expect(logs.map((l) => l.eventName)).to.deep.equal(["VaultPaused"]);
            expect(logs[0].args).to.deep.equal({ by: getAddress(f.owner.account.address), evidenceHash: evidence });
            expect((await f.vault.read.getState()).paused).to.equal(true);
        });

        it("F-05 ②: while paused, spend is blocked PAUSED and no tokens move", async function () {
            const { f } = await readyWithPolicy();
            await ownerToggle(f, "pause", hashOf("pause"));
            const b0 = await balances(f);
            const evidence = hashOf("ev-paused-spend");

            const { logs, receipt } = await spend(f, {
                requestId: hashOf("while-paused"),
                merchant: f.merchantA.account.address,
                amount: 5_000n,
                evidenceHash: evidence,
            });

            expect(receipt.status).to.equal("success");
            expect(await balances(f)).to.deep.equal(b0);
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendBlocked"]);
            expect(logs[0].args).to.deep.equal({
                requestId: hashOf("while-paused"),
                merchant: getAddress(f.merchantA.account.address),
                amount: 5_000n,
                fee: 50n,
                reason: REASON.PAUSED,
                policyVersion: 1n,
                evidenceHash: evidence,
            });
        });

        it("F-05 ③: pause by a non-owner fails (NotOwner) and the vault stays unpaused", async function () {
            const { f } = await readyWithPolicy();
            await expectRevert(f.vault.write.pause([hashOf("x")], { account: f.agent.account }), "NotOwner");
            await expectRevert(f.vault.write.pause([hashOf("x")], { account: f.stranger.account }), "NotOwner");
            expect((await f.vault.read.getState()).paused).to.equal(false);
        });

        it("pause twice fails AlreadyPaused; unpause when not paused fails NotPaused; unpause restores spending", async function () {
            const { f } = await readyWithPolicy();
            await expectRevert(f.vault.write.unpause([hashOf("x")], { account: f.owner.account }), "NotPaused");
            await ownerToggle(f, "pause", hashOf("p"));
            await expectRevert(f.vault.write.pause([hashOf("x")], { account: f.owner.account }), "AlreadyPaused");

            const evidence = hashOf("ev-unpause");
            const { logs } = await ownerToggle(f, "unpause", evidence);
            expect(logs[0].eventName).to.equal("VaultUnpaused");
            expect(logs[0].args).to.deep.equal({ by: getAddress(f.owner.account.address), evidenceHash: evidence });

            const r = await spend(f, { requestId: hashOf("after"), merchant: f.merchantA.account.address, amount: 5_000n });
            expect(r.logs[0].eventName).to.equal("SpendExecuted");
        });
    });

    describe("F-06 ① / F-09 block is an event, not a revert; fee counts toward budget", function () {
        it("F-06 ①: an over-budget spend mines, returns false, leaves balances unchanged and logs SpendBlocked(OVER_BUDGET)", async function () {
            const { f } = await readyWithPolicy({ budget: 100_000n, approvalThreshold: 100_000n });
            const b0 = await balances(f);
            const evidence = hashOf("ev-over");
            const req = { requestId: hashOf("over"), merchant: f.merchantA.account.address, amount: 100_000n, evidenceHash: evidence };

            expect(await simulateSpend(f, req)).to.equal(false);
            const { logs, receipt } = await spend(f, req);

            expect(receipt.status).to.equal("success");
            expect(await balances(f)).to.deep.equal(b0);
            expect(logs.map((l) => l.eventName)).to.deep.equal(["SpendBlocked"]);
            expect(logs[0].args).to.deep.equal({
                requestId: hashOf("over"),
                merchant: getAddress(f.merchantA.account.address),
                amount: 100_000n,
                fee: 1_000n,
                reason: REASON.OVER_BUDGET,
                policyVersion: 1n,
                evidenceHash: evidence,
            });
        });

        it("F-09: quoteFee is 1% rounded down (99→0, 100→1, 101→1, 30000→300)", async function () {
            const f = await loadFixture(deployFundedVault);
            expect(await f.vault.read.quoteFee([99n])).to.equal(0n);
            expect(await f.vault.read.quoteFee([100n])).to.equal(1n);
            expect(await f.vault.read.quoteFee([101n])).to.equal(1n);
            expect(await f.vault.read.quoteFee([30_000n])).to.equal(300n);
        });

        it("F-09: a ≤ R but a + fee > R is blocked OVER_BUDGET (E2E step 6 shape: request the whole remaining)", async function () {
            const { f } = await readyWithPolicy();
            await spend(f, { requestId: hashOf("s1"), merchant: f.merchantA.account.address, amount: 30_000n });
            const remaining = await f.vault.read.remainingBudget();
            expect(remaining).to.equal(169_700n);

            const { logs } = await spend(f, {
                requestId: hashOf("all"),
                merchant: f.merchantB.account.address,
                amount: remaining,
                agentReviewRequest: true,
            });

            expect(logs[0].eventName).to.equal("SpendBlocked");
            expect(logs[0].args.reason).to.equal(REASON.OVER_BUDGET);
            expect(logs[0].args.fee).to.equal(1_697n);
            expect(await f.vault.read.remainingBudget()).to.equal(169_700n);
        });

        it("F-09 boundary: amount + fee exactly equal to the remaining budget executes and leaves 0", async function () {
            const { f } = await readyWithPolicy({ budget: 101_000n, approvalThreshold: 101_000n });
            const { logs } = await spend(f, { requestId: hashOf("exact"), merchant: f.merchantA.account.address, amount: 100_000n });
            expect(logs[0].eventName).to.equal("SpendExecuted");
            expect(await f.vault.read.remainingBudget()).to.equal(0n);
        });

        it("reserved budget counts: a request that fits the budget only if pending items are ignored is blocked OVER_BUDGET", async function () {
            const { f } = await readyWithPolicy({ budget: 100_000n });
            await spend(f, { requestId: hashOf("p"), merchant: f.merchantA.account.address, amount: 60_000n });
            const { logs } = await spend(f, { requestId: hashOf("q"), merchant: f.merchantA.account.address, amount: 40_000n });
            expect(logs[0].args.reason).to.equal(REASON.OVER_BUDGET);
        });
    });

    describe("other block reasons and priority", function () {
        it("NO_POLICY: spend before any setPolicy is blocked with policyVersion 0", async function () {
            const f = await ready();
            const { logs } = await spend(f, { requestId: hashOf("np"), merchant: f.merchantA.account.address, amount: 1_000n });
            expect(logs[0].eventName).to.equal("SpendBlocked");
            expect(logs[0].args.reason).to.equal(REASON.NO_POLICY);
            expect(logs[0].args.policyVersion).to.equal(0n);
        });

        it("MERCHANT_NOT_ALLOWED: a merchant outside the list is blocked", async function () {
            const { f } = await readyWithPolicy();
            const b0 = await balances(f);
            const { logs } = await spend(f, { requestId: hashOf("x"), merchant: f.merchantX.account.address, amount: 1_000n });
            expect(logs[0].args.reason).to.equal(REASON.MERCHANT_NOT_ALLOWED);
            expect(await balances(f)).to.deep.equal(b0);
        });

        it("INSUFFICIENT_VAULT_BALANCE: vault must hold amount + fee + reserved", async function () {
            const f = await ready();
            await setPolicy(f, { budget: 5_000_000n, approvalThreshold: 1_000_000n });
            await spend(f, { requestId: hashOf("res"), merchant: f.merchantA.account.address, amount: 900_000n, agentReviewRequest: true });
            // vault 1,000,000, reserved 909,000 → 90,099 + fee 900 fits exactly (999,999); afterwards free = 1
            const ok = await spend(f, { requestId: hashOf("fits"), merchant: f.merchantA.account.address, amount: 90_099n });
            expect(ok.logs[0].eventName).to.equal("SpendExecuted");
            const { logs } = await spend(f, { requestId: hashOf("no"), merchant: f.merchantA.account.address, amount: 2n });
            expect(logs[0].args.reason).to.equal(REASON.INSUFFICIENT_VAULT_BALANCE);
        });

        it("priority: PAUSED beats every other reason; blocks beat pending", async function () {
            const { f } = await readyWithPolicy();
            await ownerToggle(f, "pause", hashOf("p"));
            const { logs } = await spend(f, {
                requestId: hashOf("pp"),
                merchant: f.merchantX.account.address,
                amount: 10_000_000n,
                agentReviewRequest: true,
            });
            expect(logs[0].args.reason).to.equal(REASON.PAUSED);
        });
    });

    describe("F-08 burst limits", function () {
        it("F-08: the 4th attempt in the same minute is blocked RATE_LIMIT_MINUTE; only 3 transfers happen", async function () {
            const { f } = await readyWithPolicy();
            const merchant = f.merchantA.account.address;
            const results = [];
            for (let i = 0; i < 4; i++) {
                results.push(await spend(f, { requestId: hashOf(`m${i}`), merchant, amount: 1_000n }));
            }
            expect(results.map((r) => r.logs[0].eventName)).to.deep.equal([
                "SpendExecuted",
                "SpendExecuted",
                "SpendExecuted",
                "SpendBlocked",
            ]);
            expect(results[3].logs[0].args.reason).to.equal(REASON.RATE_LIMIT_MINUTE);
            expect((await balances(f)).merchantA).to.equal(3_000n);
        });

        it("F-08 boundary: the next minute bucket accepts again", async function () {
            const { f } = await readyWithPolicy();
            const merchant = f.merchantA.account.address;
            for (let i = 0; i < 3; i++) await spend(f, { requestId: hashOf(`m${i}`), merchant, amount: 1_000n });
            await time.increase(MINUTE);
            const { logs } = await spend(f, { requestId: hashOf("next"), merchant, amount: 1_000n });
            expect(logs[0].eventName).to.equal("SpendExecuted");
            expect((await f.vault.read.getState()).minuteCount).to.equal(1);
        });

        it("F-08: the 21st attempt in the same day is blocked RATE_LIMIT_DAY", async function () {
            const { f } = await readyWithPolicy();
            const merchant = f.merchantA.account.address;
            for (let i = 0; i < 20; i++) {
                if (i > 0 && i % 3 === 0) await time.increase(MINUTE);
                const r = await spend(f, { requestId: hashOf(`d${i}`), merchant, amount: 1_000n });
                expect(r.logs[0].eventName, `attempt ${i + 1}`).to.equal("SpendExecuted");
            }
            const s = await f.vault.read.getState();
            expect(s.dayCount).to.equal(20);
            expect(s.minuteCount).to.equal(2);

            const { logs } = await spend(f, { requestId: hashOf("d21"), merchant, amount: 1_000n });
            expect(logs[0].args.reason).to.equal(REASON.RATE_LIMIT_DAY);
            await time.increase(DAY);
            const next = await spend(f, { requestId: hashOf("d-next"), merchant, amount: 1_000n });
            expect(next.logs[0].eventName).to.equal("SpendExecuted");
        });

        it("D-07: attempts blocked before the rate check (paused) do not count; attempts blocked after it (merchant) do", async function () {
            const { f } = await readyWithPolicy();
            await ownerToggle(f, "pause", hashOf("p"));
            for (let i = 0; i < 3; i++) {
                await spend(f, { requestId: hashOf(`paused${i}`), merchant: f.merchantA.account.address, amount: 1_000n });
            }
            await ownerToggle(f, "unpause", hashOf("u"));
            expect((await f.vault.read.getState()).minuteCount).to.equal(0);

            for (let i = 0; i < 3; i++) {
                const r = await spend(f, { requestId: hashOf(`x${i}`), merchant: f.merchantX.account.address, amount: 1_000n });
                expect(r.logs[0].args.reason).to.equal(REASON.MERCHANT_NOT_ALLOWED);
            }
            const { logs } = await spend(f, { requestId: hashOf("a"), merchant: f.merchantA.account.address, amount: 1_000n });
            expect(logs[0].args.reason).to.equal(REASON.RATE_LIMIT_MINUTE);
        });
    });

    describe("getState", function () {
        it("returns vault balance, merchants, counters and the current block in one call", async function () {
            const { f, policy } = await readyWithPolicy();
            await spend(f, { requestId: hashOf("a"), merchant: f.merchantA.account.address, amount: 30_000n });

            const s = await f.vault.read.getState();
            const latest = await f.publicClient.getBlock();
            expect(s.vaultBalance).to.equal(1_000_000n - 30_300n);
            expect(s.merchants.map((m: Address) => getAddress(m))).to.deep.equal(policy.merchants.map((m) => getAddress(m)));
            expect(s.minuteCount).to.equal(1);
            expect(s.dayCount).to.equal(1);
            expect(s.minuteBucket).to.equal(latest.timestamp / 60n);
            expect(s.dayBucket).to.equal(latest.timestamp / 86_400n);
            expect(s.blockNumber >= latest.number).to.equal(true);
            expect(s.blockTimestamp >= latest.timestamp).to.equal(true);
        });
    });
});
