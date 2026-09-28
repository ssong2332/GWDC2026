// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Holds a delegated budget and is the final judge of every agent spend.
/// Policy violations do not revert: they emit SpendBlocked and return false (ADR-0002).
contract PolicyVault {
    using SafeERC20 for IERC20;

    struct PolicyInput {
        uint256 budget;
        uint256 approvalThreshold;
        uint64 expiresAt;
        uint32 maxPerMinute;
        uint32 maxPerDay;
        address[] merchants;
    }

    struct Pending {
        address merchant;
        uint256 amount;
        uint256 fee;
        uint64 policyVersion;
        uint8 flags;
        uint8 status;
        bytes32 evidenceHash;
    }

    struct VaultState {
        bool paused;
        uint64 policyVersion;
        uint256 budget;
        uint256 spent;
        uint256 reserved;
        uint256 approvalThreshold;
        uint64 expiresAt;
        uint32 maxPerMinute;
        uint32 maxPerDay;
        uint64 minuteBucket;
        uint32 minuteCount;
        uint64 dayBucket;
        uint32 dayCount;
        uint32 pendingCount;
        uint256 vaultBalance;
        uint16 feeBps;
        address[] merchants;
        uint64 blockTimestamp;
        uint64 blockNumber;
    }

    struct Policy {
        uint256 budget;
        uint256 approvalThreshold;
        uint64 expiresAt;
        uint32 maxPerMinute;
        uint32 maxPerDay;
    }

    event PolicySet(uint64 indexed policyVersion, address indexed by, uint256 budget, uint256 approvalThreshold,
        uint64 expiresAt, uint32 maxPerMinute, uint32 maxPerDay, address[] merchants, bytes32 evidenceHash);
    event SpendExecuted(bytes32 indexed requestId, address indexed merchant, uint256 amount, uint256 fee,
        uint64 policyVersion, bool viaApproval, bytes32 evidenceHash);
    event SpendBlocked(bytes32 indexed requestId, address indexed merchant, uint256 amount, uint256 fee,
        uint8 reason, uint64 policyVersion, bytes32 evidenceHash);
    event SpendPending(bytes32 indexed requestId, address indexed merchant, uint256 amount, uint256 fee,
        uint8 flags, uint64 policyVersion, bytes32 evidenceHash);
    event Approved(bytes32 indexed requestId, address indexed approver, bytes32 evidenceHash);
    event Rejected(bytes32 indexed requestId, address indexed approver, bytes32 evidenceHash);
    event VaultPaused(address indexed by, bytes32 evidenceHash);
    event VaultUnpaused(address indexed by, bytes32 evidenceHash);

    error ZeroAddress();
    error InvalidFee();
    error NotOwner();
    error NotAgent();
    error InvalidPolicy(uint8 field);
    error PendingExists();
    error DuplicateRequest();
    error InvalidAmount();
    error PendingNotFound();
    error VaultIsPaused();
    error PolicyExpired();
    error AlreadyPaused();
    error NotPaused();

    // BlockReason — src/core/domain/reasons.ts must stay 1:1 with these codes.
    uint8 internal constant REASON_PAUSED = 1;
    uint8 internal constant REASON_NO_POLICY = 2;
    uint8 internal constant REASON_EXPIRED = 3;
    uint8 internal constant REASON_RATE_LIMIT_MINUTE = 4;
    uint8 internal constant REASON_RATE_LIMIT_DAY = 5;
    uint8 internal constant REASON_MERCHANT_NOT_ALLOWED = 6;
    uint8 internal constant REASON_OVER_BUDGET = 7;
    uint8 internal constant REASON_INSUFFICIENT_VAULT_BALANCE = 8;

    uint8 internal constant FLAG_OVER_THRESHOLD = 1;
    uint8 internal constant FLAG_AGENT_REVIEW_REQUEST = 2;

    uint8 internal constant STATUS_PENDING = 1;
    uint8 internal constant STATUS_APPROVED = 2;
    uint8 internal constant STATUS_REJECTED = 3;

    // InvalidPolicy(field) — 1-based position of the offending PolicyInput field.
    uint8 internal constant FIELD_BUDGET = 1;
    uint8 internal constant FIELD_APPROVAL_THRESHOLD = 2;
    uint8 internal constant FIELD_EXPIRES_AT = 3;
    uint8 internal constant FIELD_MAX_PER_MINUTE = 4;
    uint8 internal constant FIELD_MAX_PER_DAY = 5;
    uint8 internal constant FIELD_MERCHANTS = 6;

    uint16 internal constant MAX_FEE_BPS = 1000;
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAX_MERCHANTS = 20;

    IERC20 public immutable token;
    address public immutable owner;
    address public immutable agent;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;

    bool internal paused;
    uint64 internal policyVersion;
    Policy internal policy;
    mapping(address => bool) public isAllowedMerchant;
    address[] internal merchantList;
    uint256 internal spent;
    uint256 internal reserved;
    uint64 internal minuteBucket;
    uint32 internal minuteCount;
    uint64 internal dayBucket;
    uint32 internal dayCount;
    mapping(bytes32 => Pending) internal pendings;
    uint32 internal pendingCount;
    mapping(bytes32 => bool) internal usedRequestIds;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(IERC20 token_, address owner_, address agent_, address feeRecipient_, uint16 feeBps_) {
        if (
            address(token_) == address(0) || owner_ == address(0) || agent_ == address(0)
                || feeRecipient_ == address(0)
        ) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        token = token_;
        owner = owner_;
        agent = agent_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    function setPolicy(PolicyInput calldata p, bytes32 evidenceHash) external onlyOwner {
        if (pendingCount != 0) revert PendingExists();
        _validatePolicy(p);

        for (uint256 i = 0; i < merchantList.length; i++) {
            isAllowedMerchant[merchantList[i]] = false;
        }
        delete merchantList;
        for (uint256 i = 0; i < p.merchants.length; i++) {
            address m = p.merchants[i];
            if (m == address(0) || isAllowedMerchant[m]) revert InvalidPolicy(FIELD_MERCHANTS);
            isAllowedMerchant[m] = true;
            merchantList.push(m);
        }

        policy = Policy(p.budget, p.approvalThreshold, p.expiresAt, p.maxPerMinute, p.maxPerDay);
        spent = 0;
        policyVersion += 1;
        emit PolicySet(
            policyVersion,
            msg.sender,
            p.budget,
            p.approvalThreshold,
            p.expiresAt,
            p.maxPerMinute,
            p.maxPerDay,
            p.merchants,
            evidenceHash
        );
    }

    function spend(bytes32 requestId, address merchant, uint256 amount, bool agentReviewRequest, bytes32 evidenceHash)
        external
        onlyAgent
        returns (bool executed)
    {
        if (usedRequestIds[requestId]) revert DuplicateRequest();
        if (amount == 0) revert InvalidAmount();
        if (merchant == address(0)) revert ZeroAddress();
        usedRequestIds[requestId] = true;
        uint256 fee = quoteFee(amount);

        uint8 reason = _judge(merchant, amount, fee);
        if (reason != 0) {
            emit SpendBlocked(requestId, merchant, amount, fee, reason, policyVersion, evidenceHash);
            return false;
        }

        uint8 flags = (amount > policy.approvalThreshold ? FLAG_OVER_THRESHOLD : 0)
            | (agentReviewRequest ? FLAG_AGENT_REVIEW_REQUEST : 0);
        if (flags != 0) {
            pendings[requestId] = Pending(merchant, amount, fee, policyVersion, flags, STATUS_PENDING, evidenceHash);
            reserved += amount + fee;
            pendingCount += 1;
            emit SpendPending(requestId, merchant, amount, fee, flags, policyVersion, evidenceHash);
            return false;
        }

        spent += amount + fee;
        _pay(merchant, amount, fee);
        emit SpendExecuted(requestId, merchant, amount, fee, policyVersion, false, evidenceHash);
        return true;
    }

    function approve(bytes32 requestId, bytes32 evidenceHash) external onlyOwner {
        Pending storage p = pendings[requestId];
        if (p.status != STATUS_PENDING) revert PendingNotFound();
        if (paused) revert VaultIsPaused();
        if (block.timestamp >= policy.expiresAt) revert PolicyExpired();

        p.status = STATUS_APPROVED;
        uint256 total = p.amount + p.fee;
        reserved -= total;
        spent += total;
        pendingCount -= 1;
        _pay(p.merchant, p.amount, p.fee);
        emit Approved(requestId, msg.sender, evidenceHash);
        emit SpendExecuted(requestId, p.merchant, p.amount, p.fee, p.policyVersion, true, p.evidenceHash);
    }

    function reject(bytes32 requestId, bytes32 evidenceHash) external onlyOwner {
        Pending storage p = pendings[requestId];
        if (p.status != STATUS_PENDING) revert PendingNotFound();

        p.status = STATUS_REJECTED;
        reserved -= p.amount + p.fee;
        pendingCount -= 1;
        emit Rejected(requestId, msg.sender, evidenceHash);
    }

    function pause(bytes32 evidenceHash) external onlyOwner {
        if (paused) revert AlreadyPaused();
        paused = true;
        emit VaultPaused(msg.sender, evidenceHash);
    }

    function unpause(bytes32 evidenceHash) external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit VaultUnpaused(msg.sender, evidenceHash);
    }

    function getState() external view returns (VaultState memory s) {
        s.paused = paused;
        s.policyVersion = policyVersion;
        s.budget = policy.budget;
        s.spent = spent;
        s.reserved = reserved;
        s.approvalThreshold = policy.approvalThreshold;
        s.expiresAt = policy.expiresAt;
        s.maxPerMinute = policy.maxPerMinute;
        s.maxPerDay = policy.maxPerDay;
        s.minuteBucket = minuteBucket;
        s.minuteCount = minuteCount;
        s.dayBucket = dayBucket;
        s.dayCount = dayCount;
        s.pendingCount = pendingCount;
        s.vaultBalance = token.balanceOf(address(this));
        s.feeBps = feeBps;
        s.merchants = merchantList;
        s.blockTimestamp = uint64(block.timestamp);
        s.blockNumber = uint64(block.number);
    }

    function remainingBudget() public view returns (uint256) {
        return policy.budget - spent - reserved;
    }

    function quoteFee(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, feeBps, BPS_DENOMINATOR);
    }

    function getPending(bytes32 requestId) external view returns (Pending memory) {
        return pendings[requestId];
    }

    /// @dev Steps 1..8 of the spend decision (Architecture "spend 판정 순서"). Returns 0 when not blocked.
    /// Counts the attempt against the minute/day windows once steps 1..5 pass (D-07).
    function _judge(address merchant, uint256 amount, uint256 fee) internal returns (uint8) {
        if (paused) return REASON_PAUSED;
        if (policyVersion == 0) return REASON_NO_POLICY;
        if (block.timestamp >= policy.expiresAt) return REASON_EXPIRED;

        uint64 minute = uint64(block.timestamp / 60);
        uint64 day = uint64(block.timestamp / 86_400);
        uint32 minuteSoFar = minuteBucket == minute ? minuteCount : 0;
        uint32 daySoFar = dayBucket == day ? dayCount : 0;
        if (minuteSoFar >= policy.maxPerMinute) return REASON_RATE_LIMIT_MINUTE;
        if (daySoFar >= policy.maxPerDay) return REASON_RATE_LIMIT_DAY;
        minuteBucket = minute;
        minuteCount = minuteSoFar + 1;
        dayBucket = day;
        dayCount = daySoFar + 1;

        if (!isAllowedMerchant[merchant]) return REASON_MERCHANT_NOT_ALLOWED;
        uint256 remaining = remainingBudget();
        // amount + fee > remaining, written so that huge amounts cannot overflow
        if (amount > remaining || fee > remaining - amount) return REASON_OVER_BUDGET;
        if (token.balanceOf(address(this)) < amount + fee + reserved) return REASON_INSUFFICIENT_VAULT_BALANCE;
        return 0;
    }

    function _validatePolicy(PolicyInput calldata p) internal view {
        if (p.budget == 0) revert InvalidPolicy(FIELD_BUDGET);
        if (p.approvalThreshold > p.budget) revert InvalidPolicy(FIELD_APPROVAL_THRESHOLD);
        if (p.expiresAt <= block.timestamp) revert InvalidPolicy(FIELD_EXPIRES_AT);
        if (p.maxPerMinute == 0) revert InvalidPolicy(FIELD_MAX_PER_MINUTE);
        if (p.maxPerDay < p.maxPerMinute) revert InvalidPolicy(FIELD_MAX_PER_DAY);
        if (p.merchants.length == 0 || p.merchants.length > MAX_MERCHANTS) revert InvalidPolicy(FIELD_MERCHANTS);
    }

    function _pay(address merchant, uint256 amount, uint256 fee) internal {
        token.safeTransfer(merchant, amount);
        if (fee != 0) token.safeTransfer(feeRecipient, fee);
    }
}
