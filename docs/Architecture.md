# Architecture — Agent Spending Control & Evidence Layer (가칭 — PRD Open Question #2)

> 소유자: architect | 상태: 승인 | 최종 수정: 2026-09-28
> 상태는 초안/승인 두 가지. "승인"으로 바꾸는 것은 사용자만 한다 — 승인 전 구현 착수 금지 (AGENTS.md 파이프라인 규칙).

## 이 문서를 읽는 법 (금지 먼저)

- implementer는 아래 "데이터 모델과 인터페이스"의 시그니처·스키마·코드값만 쓴다. 바꿔야 하면 구현하지 말고 architect로 되돌린다.
- 표의 `(제안 — OQ #n)` 값은 사용자 확인 전 기본값이다. 값은 `src/config/constants.ts` 한 곳에만 둔다 (CodingRules "설정 및 상수").
- 개인키는 Next.js 서버 프로세스에 절대 로드하지 않는다 — CLI 프로세스만 쓴다 (D-16. Kiln 키는 D-16 범위 밖 — 서버도 `KILN_API_KEY`를 로드한다, `src/server/env.ts`의 `CLI_ONLY_KEYS`는 `AGENT_PRIVATE_KEY`·`OWNER_PRIVATE_KEY`만 가드).
- `(추정)`이 붙은 수치는 측정값이 아니다. 각 행에 확인 방법이 있다.

## 기술 스택

| 계층 | 선택 | 선택 이유 (DECISIONS/ADR 참조) |
|---|---|---|
| 언어 | TypeScript 5.x (앱·CLI·테스트), Solidity 0.8.24 (컨트랙트). Node 22.14 (설치 확인됨 — 호출자 전달, 인용) | PRD N-07 / D-02 |
| 프레임워크 | Next.js App Router (`create-next-app@latest`, TS, `src/` 디렉토리), viem 2.x (서버·CLI·브라우저 공통 체인 클라이언트), openai SDK (Kiln, `baseURL` 교체), zod (입력·Kiln 인자 검증), Hardhat 2.x + `@nomicfoundation/hardhat-toolbox-viem` (컴파일·컨트랙트 테스트·로컬 노드), OpenZeppelin Contracts 5.x (ERC20·SafeERC20) | PRD N-07 / D-03, D-04, D-15 |
| 저장소 | SQLite (`better-sqlite3`, WAL 모드, 파일 `data.local/app.sqlite`) — 증거 원문·Kiln usage·체인 이벤트 캐시. 증거 공개본은 `evidence/base-sepolia/*.json` (repo 커밋) | PRD F-11, F-12, N-09 / ADR-0003, D-14 |
| 배포 | 노트북 로컬 실행(`127.0.0.1`), 체인만 Base Sepolia(chainId 84532). 개발·테스트는 Hardhat 로컬 노드(chainId 31337) | PRD N-08, N-09 / D-17 |
| 체인 계약 | 자체 `PolicyVault` + `MockKRWT`(ERC20, decimals 0) | ADR-0001, ADR-0002, D-05 |
| 패키지 매니저 | npm (pnpm 미설치 — 호출자 전달, 인용) | D-02 |

## 구조 개요

단일 repo, **패키지 2개**: 루트(Next.js 앱 + 에이전트 코어 + CLI) / `chain/`(Hardhat 전용). npm workspaces 미사용 (D-01).

```
/                                  # 루트 패키지: Next.js 앱 + 코어 + CLI
├─ package.json  tsconfig.json  next.config.ts
├─ vitest.config.ts                # 계층 ② 단위 (tests/unit)
├─ vitest.integration.config.ts    # 계층 ③ 통합 (tests/integration, Hardhat 노드 자동 기동)
├─ .env.example                    # 변수 목록은 "배포 > 환경별 설정"
├─ src/
│  ├─ core/                        # 프레임워크 무의존 (Next·SQLite·openai·viem 클라이언트 import 금지). 허용 import는 "계층 규칙 > core 허용 import" 행 (D-29)
│  │  ├─ errors.ts                 # AppError{code, message, retryable, cause}
│  │  ├─ domain/
│  │  │  ├─ types.ts               # 3절 도메인 타입 (Hex, PolicyValues, VaultStateSnapshot, KilnErrorCode …)
│  │  │  ├─ intent.ts              # interpretIntentOutcome — Kiln outcome → IntentJudgment
│  │  │  ├─ reasons.ts             # BlockReason, PendingFlag — Solidity와 1:1
│  │  │  ├─ fee.ts                 # quoteFee(amount, feeBps)
│  │  │  ├─ policy.ts              # PolicyValues, Kiln 인자 zod 스키마, 검증
│  │  │  ├─ precheck.ts            # evaluatePrecheck(state, req) — 컨트랙트 판정 순서 미러
│  │  │  ├─ evidence.ts            # EvidencePackage 타입, canonicalize + keccak256
│  │  │  └─ replay.ts              # 이벤트 재생으로 "허용 범위 안이었나" 판정 (감사·검증 공용)
│  │  ├─ ports.ts                  # KilnClient, VaultReader, AgentVaultWriter, OwnerVaultWriter, *Repo, Clock
│  │  └─ usecases/
│  │     ├─ parsePolicy.ts         # F-01
│  │     ├─ prepareOwnerAction.ts  # F-02, F-04②, F-05 — 증거 패키지 생성 + 컨트랙트 인자 반환
│  │     ├─ processSpendRequest.ts # F-03, F-04④, F-06, F-07, F-09 — 에이전트 파이프라인
│  │     ├─ kilnRecords.ts         # KilnCallResult → kiln_calls 저장·증거 참조 변환 (parsePolicy·processSpendRequest 공용)
│  │     ├─ syncChainEvents.ts     # 이벤트 증분 수집(pullNewEvents, ADR-0004) + 증거 anchor 연결 (F-11)
│  │     ├─ verifyTx.ts            # F-12, F-13 공용 재해시·대조
│  │     ├─ buildReceipt.ts        # F-10
│  │     └─ buildEfficiencyReport.ts # F-14
│  ├─ adapters/
│  │  ├─ kiln/  openaiKilnClient.ts · fakeKilnClient.ts · requestBody.ts · prompts.ts · toolSchemas.ts · types.ts · retryPolicy.ts · thinkStrip.ts
│  │  ├─ chain/ viemVault.ts · networks.ts · generated/{PolicyVault,MockKRWT}.ts (abi+bytecode, chain:export 산출물, 커밋)
│  │  └─ db/    sqlite.ts(연결+마이그레이션) · evidenceRepo.ts · kilnCallRepo.ts · spendRequestRepo.ts · chainEventRepo.ts
│  ├─ config/  env.ts(zod 스키마 + 순수 parse 함수만 — server-only·process.env 읽기 없음, ADR-0005) · constants.ts(리터럴만, import 없음) · merchants.ts
│  ├─ server/  env.ts              # import "server-only" + 키 존재 시 시작 거부 + parseServerEnv(process.env) (ADR-0005)
│  │           container.ts        # 서버 합성 루트 (server-only) — 키 없는 어댑터만 조립
│  ├─ app/                         # Next.js App Router (페이지 + Route Handler)
│  │  ├─ layout.tsx  page.tsx(→ /dashboard 리다이렉트)
│  │  ├─ delegate/page.tsx  dashboard/page.tsx  audit/page.tsx  efficiency/page.tsx
│  │  └─ api/ policy/parse · owner-actions/prepare · owner-actions/confirm · vault/state · vault/activity · receipts/[requestId] · audit/[txHash] · efficiency
│  └─ ui/                          # 클라이언트 컴포넌트·훅
│     ├─ wallet/ WalletProvider.tsx · WalletGate.tsx · useOwnerAction.ts
│     ├─ hooks/  useApi.ts
│     └─ components/ AsyncView.tsx · TxHashLink.tsx · Krw.tsx · ReasonBadge.tsx · NavBar.tsx
├─ cli/                            # tsx 실행 스크립트 (키를 쓰는 유일한 프로세스)
│  ├─ _env.ts                      # .env → .env.cli 로드 + parseCliEnv(process.env) (ADR-0005). src/server/** import 금지
│  ├─ _container.ts                # CLI 합성 루트 (에이전트/소유자 지갑 포함)
│  ├─ deploy.ts  e2e.ts  spend.ts  owner-unpause.ts  export-evidence.ts  verify-evidence.ts
├─ tests/
│  ├─ fixtures/rule-cases.json     # 컨트랙트·precheck 공용 판정 케이스 (패리티 테스트)
│  ├─ unit/        *.test.ts       # 계층 ②
│  └─ integration/ *.test.ts, setup/hardhat-node.ts   # 계층 ③
├─ chain/                          # Hardhat 패키지 (별도 package.json)
│  ├─ package.json  hardhat.config.ts  tsconfig.json
│  ├─ contracts/ PolicyVault.sol  MockKRWT.sol
│  ├─ test/PolicyVault.test.ts     # 계층 ①
│  └─ scripts/export-artifacts.ts  # abi+bytecode → ../src/adapters/chain/generated/
├─ deployments/baseSepolia.json    # 배포 주소·deployBlock (커밋)
├─ evidence/base-sepolia/          # evidence.json, run-*.json (커밋 — 제3자 검증 입력)
└─ data.local/                     # SQLite·로컬 배포·로컬 증거 (.gitignore의 `*.local` 패턴으로 제외됨)
```

Hardhat 산출물 경로는 `chain/build/artifacts`, `chain/build/cache`로 설정한다 (`.gitignore`의 `build/`로 제외 — .gitignore는 사용자 소유라 수정하지 않는 방식).

**사용자 조치 필요 (T-01 착수 전)**: 현재 `.gitignore`에 Next.js 산출물 `.next/`와 `*.tsbuildinfo`가 없다. `.gitignore`는 사용자 소유이므로 사용자가 두 줄을 추가한다. 추가하지 않으면 T-01의 첫 빌드 산출물이 커밋 대상에 섞인다.

## 모듈 경계와 책임

| 모듈 | 책임 | 의존 대상 |
|---|---|---|
| `chain/contracts/PolicyVault.sol` | 정책 보관, 지출의 최종 판정(차단은 이벤트+false), 대기·승인·거절·중지, 증거 해시 이벤트 기록 | OpenZeppelin IERC20/SafeERC20 |
| `chain/contracts/MockKRWT.sol` | 결제 토큰(decimals 0, 누구나 mint 가능한 테스트 토큰) | OpenZeppelin ERC20 |
| `src/core/domain` | 순수 규칙: 사유 코드, 수수료, 정책 검증, 사전 검사, 증거 정규화·해시, 이벤트 재생 판정 | "core 허용 import"만 (viem 순수 유틸, zod, canonicalize, `@/config/constants`) — D-29 |
| `src/core/ports.ts` | 외부 의존 인터페이스 정의 | `core/domain` |
| `src/core/usecases` | 흐름 조정: 정책 변환, 소유자 액션 준비, 에이전트 지출 파이프라인, 이벤트 동기화, 검증, 영수증, 효율 집계 | `core/domain`, `core/ports`, `core/errors`, "core 허용 import" — D-29 |
| `src/adapters/kiln` | Kiln HTTP 호출(요청 본문 규칙·재시도·usage/헤더 수집), 가짜 구현 | openai SDK, `core/ports` |
| `src/adapters/chain` | viem으로 PolicyVault 읽기·쓰기·로그 디코드, 네트워크 정의 | viem, `core/ports` |
| `src/adapters/db` | SQLite 스키마·마이그레이션, Repo 구현 | better-sqlite3, `core/ports` |
| `src/config` | 환경 변수 스키마·순수 parse(서버·CLI·테스트 공용, 부작용 없음), 상수(리터럴), 가맹점 레지스트리 | zod, `core/domain/types`(merchants.ts만) |
| `src/server/env.ts` | 서버 프로세스 env 로드: `server-only`, 개인키 존재 시 시작 거부 (ADR-0005) | `config/env` |
| `src/server/container.ts` | Route Handler용 의존성 조립 (키 없는 어댑터만) | adapters, config, `server/env` |
| `src/app` (pages) | 4화면 라우팅·레이아웃 | `src/ui` |
| `src/app/api` | Route Handler: 입력 검증 → 유스케이스 호출 → DTO 직렬화(bigint→문자열) → 에러 매핑 | `server/container`, `core/usecases` |
| `src/ui` | 지갑 연결·서명, 화면 상태(로딩·빈 값·에러), 재사용 컴포넌트 | viem(브라우저), `core/domain`(reasons, 표시용), generated ABI 상수(`adapters/chain/generated/PolicyVault`), `app/api/_lib/dto`(타입만), `config/merchants` |
| `cli/` | 배포, E2E(계층 ④·데모), 단건 지출, 증거 내보내기, 제3자 검증 | `core/usecases`, adapters, config (`src/server/**` 금지 — ADR-0005) |

## 데이터 흐름

### A. 위임 → 정책 등록 (F-01, F-02)

1. `/delegate`에서 소유자가 문장 입력 → `POST /api/policy/parse`.
2. `parsePolicy`: KilnClient.parsePolicy (function 1개, `tool_choice:"auto"`) → kiln_calls 저장(usage·Generation-Id, flow=`policy_parse`) → tool 인자를 zod로 검증 → 실패면 `{ok:false, code}` (정책 미생성, F-01 ②).
3. 화면이 후보(예산·가맹점·임계·기한·목적)를 표시. **기한**: Kiln이 뽑은 값이 있으면 채워 두고, 없으면 빈 필수 입력 — 소유자가 보고 고치거나 넣는다 (OQ #15, 사용자 수락). 폭주 한도(분·일)는 상수 기본값으로 채워진 입력 (Kiln 추출 대상 아님, D-07).
4. 서명 버튼 → `POST /api/owner-actions/prepare {kind:"policy_set", parseCallId, final, ownerAddress}` → 서버가 최종값 재검증, 가맹점 주소 해석, 증거 패키지 생성·해시·저장 → `{evidenceId, evidenceHash, call:{functionName:"setPolicy", args}}` 반환.
5. 브라우저 지갑이 `setPolicy(p, evidenceHash)` 서명·전송 → `POST /api/owner-actions/confirm {evidenceId, txHash}` → 서버가 영수증 대기 후 `syncChainEvents` → 이벤트의 evidenceHash로 anchor 연결 → 화면에 tx hash 표시.

### B. 에이전트 지출 (F-03, F-04 ④, F-06, F-07, F-09, F-11) — `processSpendRequest`

```
입력 {merchantId, amount, itemDescription}
 → requestId = 랜덤 32바이트
 → state = VaultReader.getState()                      (에이전트 "읽기")
 → pre = evaluatePrecheck(state, req)                   (결정적, 컨트랙트 순서 미러)
 → policy = 활성 정책 증거 (ADR-0004): pullNewEvents(증분) → ChainEventRepo에서 state.policyVersion의 PolicySet
            → 그 evidenceHash → EvidenceRepo.findByHash (kind="policy_set") → purpose·delegationText
            (policyVersion 0 → ZERO_HASH·증거 없음 / 이벤트 없음 → POLICY_EVENT_NOT_FOUND
             / pass인데 로컬 증거 없음 → POLICY_EVIDENCE_NOT_FOUND — 둘 다 tx 전 throw, 지출 없음)
 ├─ pre.verdict = "block"  → Kiln 호출 0회, judgment = null, agentReviewRequest = true, flow = "rule_block"
 └─ pre.verdict = "pass"   → KilnClient.judgeIntent 1회 → zod 검증
        status "match"                         → agentReviewRequest = false
        status "mismatch" | "invalid_output" | "error" → agentReviewRequest = true   (D-10 fail-closed)
      flow = "intent_judge"
 → 증거 패키지(kind="spend_request") 생성 → canonical JSON → keccak256 → SQLite 저장 (tx 전에 저장)
 → AgentVaultWriter.spend(requestId, merchant, amount, agentReviewRequest, evidenceHash)   (에이전트 "쓰기")
 → 영수증 대기 → 로그 디코드 → SpendExecuted(토큰 이전="정산") | SpendBlocked | SpendPending
 → spend_requests.outcome 갱신, evidence anchor 연결
 → SpendOutcome 반환
```

- 사전 차단 요청도 **같은 인자로** PolicyVault에 제출한다 — tx 1개, `SpendBlocked` 1개 (ADR-0002).
- 사전 차단 제출에 `agentReviewRequest=true`를 싣는 이유: 사전 검사 시점과 채굴 시점 사이에 상태가 바뀌어(분 경계 등) 컨트랙트가 통과시키더라도, Kiln 판단 없이 자동 결제되지 않고 대기로 간다 (ADR-0002, D-12).

### C. 소유자 액션 — 승인·거절·중지 (F-04 ②③, F-05)

A의 4~5단계와 같은 경로: `prepare {kind:"approval"|"rejection"|"pause"}` → 지갑 서명(`approve/reject/pause(…, evidenceHash)`) → `confirm`. 권한 판정은 서버가 아니라 컨트랙트 `onlyOwner`가 한다 (서버는 서명 권한이 없다). 해제(`unpause`)는 화면 범위 밖 — `cli/owner-unpause.ts`와 E2E에서만 쓴다 (PRD 화면 표에 재개 버튼 없음).

### D. 감사·검증 (F-12, F-13)

`verifyTx(txHash)`: RPC로 영수증 조회 → vault 주소의 로그만 디코드 → 각 로그의 evidenceHash로 SQLite 증거 조회 → `keccak256(canonicalize(package))` 재계산 → 온체인 값과 비교 → 지출 이벤트면 `replay`로 "허용 범위 안" 판정 → `AuditResult`. `cli/verify-evidence.ts`는 SQLite 대신 **내보낸 JSON 파일**을 입력으로 같은 비교를 한다 (DB·운영자 불필요).

### E. 효율 리포트 (F-14)

`buildEfficiencyReport`: kiln_calls를 flow별 GROUP BY 합산 + spend_requests에서 `flow='rule_block'` 건수(토큰 0 행) + 에너지 추정(가정 명시). 합계는 같은 SQL의 합이다 (F-14 ③).

## 데이터 모델과 인터페이스

implementer는 여기 정의된 규격만 사용한다. 공통 규칙:

- 금액(토큰)은 **정수 원 단위**, TS에서는 `bigint`, JSON·DTO·증거 패키지에서는 **10진 문자열**.
- 주소는 JSON에서 체크섬 형식(`getAddress`), bytes32·tx hash는 소문자 `0x` hex.
- 시간: 컨트랙트·패키지 내 시각은 unix 초(`number`), 사람이 읽는 시각은 ISO 8601 UTC 문자열.

### 1. PolicyVault (Solidity 0.8.24)

#### 상태·생성자

| 항목 | 규격 |
|---|---|
| constructor | `constructor(IERC20 token, address owner, address agent, address feeRecipient, uint16 feeBps)` — 전부 `immutable`. 0 주소 → revert `ZeroAddress()`. `feeBps ≤ 1000` 아니면 revert `InvalidFee()` |
| 역할 | `owner` = 사람의 브라우저 지갑 주소 / `agent` = 에이전트 서버 키 주소. 둘 다 변경 함수 없음 (D-24) |
| 저장 상태 | `bool paused` · `uint64 policyVersion`(setPolicy마다 +1, 0=미등록) · `Policy policy` · `mapping(address=>bool) isAllowedMerchant` + `address[] merchantList` · `uint256 spent`(누적 금액+수수료) · `uint256 reserved`(대기 건 금액+수수료 합) · `uint64 minuteBucket, uint32 minuteCount, uint64 dayBucket, uint32 dayCount` · `mapping(bytes32=>Pending) pendings` · `uint32 pendingCount` · `mapping(bytes32=>bool) usedRequestIds` |
| 잔여 예산 | `remaining = budget − spent − reserved` |
| 수수료 | `fee = amount * feeBps / 10000` (내림). 판정식: `amount + fee ≤ remaining` 이어야 통과 (D-06) |

```solidity
struct PolicyInput {
    uint256 budget;             // > 0
    uint256 approvalThreshold;  // 0..budget. amount > threshold 이면 대기
    uint64  expiresAt;          // unix 초, > block.timestamp. block.timestamp >= expiresAt 이면 만료
    uint32  maxPerMinute;       // >= 1
    uint32  maxPerDay;          // >= maxPerMinute
    address[] merchants;        // 1..20개, 0 주소·중복 불가
}
struct Pending {
    address merchant; uint256 amount; uint256 fee;
    uint64 policyVersion; uint8 flags; uint8 status;   // status: 0 none, 1 pending, 2 approved, 3 rejected
    bytes32 evidenceHash;
}
struct VaultState {
    bool paused; uint64 policyVersion;
    uint256 budget; uint256 spent; uint256 reserved; uint256 approvalThreshold;
    uint64 expiresAt; uint32 maxPerMinute; uint32 maxPerDay;
    uint64 minuteBucket; uint32 minuteCount; uint64 dayBucket; uint32 dayCount;
    uint32 pendingCount; uint256 vaultBalance; uint16 feeBps;
    address[] merchants; uint64 blockTimestamp; uint64 blockNumber;
}
```

#### 함수

| 함수 | 호출자 | 동작 | revert 조건 (정책 위반이 아닌 것만) |
|---|---|---|---|
| `setPolicy(PolicyInput p, bytes32 evidenceHash)` | owner | 정책 교체, `spent=0`, 가맹점 목록 교체, `policyVersion++`, `PolicySet` 발행 | `NotOwner`, `InvalidPolicy(uint8 field)`, `PendingExists`(대기 건이 있으면 먼저 승인·거절) |
| `spend(bytes32 requestId, address merchant, uint256 amount, bool agentReviewRequest, bytes32 evidenceHash) returns (bool executed)` | agent | 아래 판정 순서. 차단이면 `SpendBlocked`+`false`, 대기면 `SpendPending`+`false`, 실행이면 토큰 이전+`SpendExecuted`+`true` | `NotAgent`, `DuplicateRequest`, `InvalidAmount`(0), `ZeroAddress` |
| `approve(bytes32 requestId, bytes32 evidenceHash)` | owner | 대기 건 실행: merchant에 amount, feeRecipient에 fee 이전, `reserved −= amount+fee`, `spent += amount+fee`, `Approved` 다음 `SpendExecuted(viaApproval=true)` | `NotOwner`, `PendingNotFound`, `VaultIsPaused`, `PolicyExpired` |
| `reject(bytes32 requestId, bytes32 evidenceHash)` | owner | `reserved −= amount+fee`, status=3, `Rejected` | `NotOwner`, `PendingNotFound` |
| `pause(bytes32 evidenceHash)` / `unpause(bytes32 evidenceHash)` | owner | `paused` 전환, `VaultPaused`/`VaultUnpaused` | `NotOwner`, `AlreadyPaused` / `NotPaused` |
| `getState() view returns (VaultState)` | 누구나 | 한 번에 전체 상태 (사전 검사 입력) | — |
| `remainingBudget() view returns (uint256)` | 누구나 | 잔여 예산 (에이전트 "읽기", F-03 ③) | — |
| `quoteFee(uint256) view returns (uint256)` | 누구나 | 수수료 계산 | — |
| `getPending(bytes32) view returns (Pending)` | 누구나 | 대기 건 조회 | — |
| `isAllowedMerchant(address) view returns (bool)` | 누구나 | public mapping getter | — |

`reject`는 PRD에 명시된 함수가 아니다 — 대기 건이 예산을 예약(reserved)하므로 예약을 풀 수단으로 둔다 (D-08, 보고서에서 사용자 확인 요청).

- `InvalidPolicy(uint8 field)` 코드 = `PolicyInput` 필드 순서: 1 budget, 2 approvalThreshold, 3 expiresAt, 4 maxPerMinute, 5 maxPerDay, 6 merchants (D-31).
- `approve`·`reject`는 `pendingCount -= 1`. `setPolicy`는 분·일 카운터(`minuteBucket/Count`, `dayBucket/Count`)를 리셋하지 않는다 (D-31).

#### `spend` 판정 순서 (TS `evaluatePrecheck`가 같은 순서를 미러 — 패리티 테스트 대상)

| 순서 | 조건 | 결과 |
|---|---|---|
| 0 | `usedRequestIds[requestId]` / amount==0 / merchant==0 | revert (입력 오류, 기록 아님) |
| — | 이하 모든 경로에서 `usedRequestIds[requestId]=true`, `fee=quoteFee(amount)` | |
| 1 | `paused` | Blocked `PAUSED(1)` |
| 2 | `policyVersion == 0` | Blocked `NO_POLICY(2)` |
| 3 | `block.timestamp >= expiresAt` | Blocked `EXPIRED(3)` |
| 4 | 현재 분 버킷(`block.timestamp/60`) 카운트 `>= maxPerMinute` | Blocked `RATE_LIMIT_MINUTE(4)` |
| 5 | 현재 일 버킷(`block.timestamp/86400`) 카운트 `>= maxPerDay` | Blocked `RATE_LIMIT_DAY(5)` |
| — | 여기까지 통과하면 분·일 카운트 +1 (버킷이 바뀌었으면 리셋 후 1) | |
| 6 | `!isAllowedMerchant[merchant]` | Blocked `MERCHANT_NOT_ALLOWED(6)` |
| 7 | `amount + fee > remaining` | Blocked `OVER_BUDGET(7)` |
| 8 | `token.balanceOf(this) < amount + fee + reserved` | Blocked `INSUFFICIENT_VAULT_BALANCE(8)` |
| 9 | `amount > approvalThreshold` 또는 `agentReviewRequest` | Pending, `flags = (amount>threshold ? 1 : 0) \| (agentReviewRequest ? 2 : 0)`, `reserved += amount+fee`, `pendingCount++` |
| 10 | 그 외 | 실행: merchant에 amount, feeRecipient에 fee 이전, `spent += amount+fee` |

차단(1~8)이 대기(9)보다 우선한다. 사유 코드 0은 `NONE`(사용 안 함).

#### 이벤트 (모든 금액 필드 `uint256`, 사유·플래그는 `uint8`)

```solidity
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
```

- `SpendExecuted(viaApproval=true)`의 `evidenceHash`는 **원래 지출 요청의** 해시다. 승인 증거 해시는 같은 tx의 `Approved`에 있다.
- evidenceHash = `keccak256(utf8(canonicalJSON(package)))` — 5절.

#### 사유·플래그 코드 (TS `src/core/domain/reasons.ts`와 1:1)

| 코드 | 이름 | UI 라벨 (영어) | 데모 사용 |
|---|---|---|---|
| 1 | PAUSED | Paused by owner | E2E 8단계 |
| 2 | NO_POLICY | No policy registered | 단위 테스트 |
| 3 | EXPIRED | Policy expired | 단위 테스트만 (PRD F-03 ④) |
| 4 | RATE_LIMIT_MINUTE | Too many attempts this minute | E2E 7단계 (F-08) |
| 5 | RATE_LIMIT_DAY | Too many attempts today | 단위 테스트 |
| 6 | MERCHANT_NOT_ALLOWED | Merchant not allowed | E2E 3단계 |
| 7 | OVER_BUDGET | Over budget (incl. fee) | E2E 6단계 |
| 8 | INSUFFICIENT_VAULT_BALANCE | Vault balance too low | 단위 테스트 |
| flag 1 | OVER_THRESHOLD | Above approval threshold | E2E 4단계 |
| flag 2 | AGENT_REVIEW_REQUEST | AI flagged / review requested | E2E 5단계 |

### 2. MockKRWT (Solidity)

`ERC20("Mock KRW Token","mKRW")`, `decimals()` → `0`, `mint(address to, uint256 amount)` 누구나 호출 가능 (테스트 토큰임을 README·UI에 표기). **1 mKRW = 1원** (D-05, 제안 — OQ #11).

### 3. 도메인 타입 (`src/core/domain`, TS)

```ts
type Hex = `0x${string}`;
enum BlockReason { NONE=0, PAUSED=1, NO_POLICY=2, EXPIRED=3, RATE_LIMIT_MINUTE=4, RATE_LIMIT_DAY=5,
                   MERCHANT_NOT_ALLOWED=6, OVER_BUDGET=7, INSUFFICIENT_VAULT_BALANCE=8 }
const PendingFlag = { OVER_THRESHOLD: 1, AGENT_REVIEW_REQUEST: 2 } as const;

type MerchantEntry = { id: string; displayName: string; aliases: string[]; address: Hex };

type PolicyValues = {
  budget: bigint; approvalThreshold: bigint; expiresAt: number;      // unix 초
  maxPerMinute: number; maxPerDay: number; merchantIds: string[]; purpose: string;
};

type VaultStateSnapshot = {   // getState() 매핑 + 체인 정보
  chainId: number; vault: Hex; paused: boolean; policyVersion: bigint;
  budget: bigint; spent: bigint; reserved: bigint; approvalThreshold: bigint;
  expiresAt: number; maxPerMinute: number; maxPerDay: number;
  minuteBucket: bigint; minuteCount: number; dayBucket: bigint; dayCount: number;
  pendingCount: number; vaultBalance: bigint; feeBps: number; merchants: Hex[];
  blockTimestamp: number; blockNumber: bigint;
};

type SpendRequestInput = { merchantId: string; amount: bigint; itemDescription: string };  // itemDescription 1..200자

type PrecheckResult =
  | { verdict: "pass";  expected: "execute" | "pending"; fee: bigint }
  | { verdict: "block"; reason: BlockReason; fee: bigint };

function quoteFee(amount: bigint, feeBps: number): bigint;
function evaluatePrecheck(s: VaultStateSnapshot, r: { merchant: Hex; amount: bigint }): PrecheckResult;
// 분·일 버킷 유효 카운트 = (저장 버킷 == floor(blockTimestamp/60 또는 /86400)) ? 저장 카운트 : 0

type IntentJudgment = {
  status: "match" | "mismatch" | "invalid_output" | "error";
  reason: string;          // Kiln 문장(≤200자) 또는 실패 사유 코드: invalid_output → NO_TOOL_CALL | WRONG_FUNCTION | INVALID_ARGS, error → KilnErrorCode (D-32)
  kilnCallId: string;
};

type SpendOutcome = {
  requestId: Hex; flow: "rule_block" | "intent_judge"; txHash: Hex;
  outcome: "executed" | "blocked" | "pending";
  blockReason: BlockReason | null; pendingFlags: number | null;
  evidenceHash: Hex; kilnCalls: 0 | 1;
  precheckAgreed: boolean;   // 사전 검사 예측 == 온체인 결과
};
```

#### 정책 검증 규칙 (`policy.ts`, zod) — Kiln 인자와 소유자 최종값 모두에 적용

| 필드 | 규칙 | 실패 코드 |
|---|---|---|
| total_budget_krw → budget | 정수, 1 ≤ x ≤ 100,000,000 | `SCHEMA_INVALID` |
| approval_threshold_krw → approvalThreshold | 정수, 0 ≤ x ≤ budget | `SCHEMA_INVALID` |
| allowed_merchant_ids → merchantIds | 1..20개, 중복 없음, 전부 레지스트리 id | `UNKNOWN_MERCHANT` |
| unrecognized_merchants | 문자열 배열(선택). 비어 있지 않으면 **경고**로 표시(정책에서 제외됨을 알림), 에러 아님 | — |
| expires_on → expiresAt | Kiln: `YYYY-MM-DD` 또는 null. 날짜 → 그 날 23:59:59 Asia/Seoul의 unix 초. 최종값(prepare)은 **필수**, `> now` | `SCHEMA_INVALID` / `EXPIRY_REQUIRED` |
| purpose | 1..200자 | `SCHEMA_INVALID` |
| maxPerMinute / maxPerDay (최종값만) | 1 ≤ perMinute ≤ perDay ≤ 1000 | `SCHEMA_INVALID` |

#### 가맹점 레지스트리 (`src/config/merchants.ts`) — 데모용 고정 주소, 개인키 없음

| id | displayName | aliases | address |
|---|---|---|---|
| daiso | Daiso | 다이소, Daiso | `0x000000000000000000000000000000000000da15` |
| coupang | Coupang | 쿠팡, Coupang | `0x000000000000000000000000000000000000c0a9` |
| gmarket | Gmarket | G마켓, 지마켓, Gmarket | `0x0000000000000000000000000000000000009a4e` |

(gmarket은 데모의 "비허용 가맹점" 역할 — 레지스트리에는 있으나 예문 정책에는 없다.)

### 4. Kiln 클라이언트 (`src/core/ports.ts` + `src/adapters/kiln`)

```ts
interface KilnClient {
  parsePolicy(i: { delegationText: string; todayKst: string /*YYYY-MM-DD*/; merchants: MerchantEntry[] }): Promise<KilnCallResult>;
  judgeIntent(i: { purpose: string; delegationText: string; merchantName: string; amount: bigint; itemDescription: string }): Promise<KilnCallResult>;
}
type KilnCallResult = {
  record: KilnCallRecord;   // 항상 반환 — 실패도 기록
  outcome:
    | { kind: "tool_call"; functionName: string; rawArguments: string }
    | { kind: "no_tool_call"; content: string }                      // content는 <think>…</think> 제거 후
    | { kind: "http_error"; status: number; code: string | null };
};
type KilnCallRecord = {
  callId: string; flow: "policy_parse" | "intent_judge"; provider: "kiln" | "fake"; model: string;
  httpStatus: number | null; finishReason: string | null; attempts: number; latencyMs: number;
  promptTokens: number; completionTokens: number; reasoningTokens: number | null;  // null = 응답에 없음
  totalTokens: number; cachedTokens: number | null; costUsd: string | null;       // usage.cost를 String()으로
  generationId: string | null;                                                    // X-Neocloud-Generation-Id
  thinkingMode: "default" | "kwargs_off" | "no_think"; createdAt: string;
};
```

- `KilnCallRepo.findById`는 위 `KilnCallRecord`에 `rawArguments: string | null`을 더해 반환한다(`src/core/ports.ts`) — 도구 호출 원문 인자를 그대로 보관해, policy_set 증거가 Kiln 후보값을 원문 그대로 쥘 수 있게 한다.
- 검증(zod)은 유스케이스가 한다. 클라이언트는 전송·재시도·usage 수집만 한다.
- `FakeKilnClient`: 생성자에 응답 핸들러를 주입(테스트는 큐, E2E·UI 개발 기본 핸들러는 결정적 규칙: 판단은 itemDescription이 `/personal|gaming|개인/i`에 맞으면 mismatch). `provider:"fake"`로 기록되어 효율 리포트의 실측 행과 섞이지 않는다.

#### 요청 본문 (`requestBody.ts`의 순수 함수 `buildChatBody(kind, input, cfg)` — 단위 테스트 대상, F-01 ③)

| 필드 | 값 |
|---|---|
| `model` | `KILN_MODEL` (기본 `qwen3-32b`) |
| `messages` | `[system, user]` 2개. system에 규칙·레지스트리·오늘 날짜(KST), user에 원문 |
| `tools` | function **1개** (아래), `description` 필수 |
| `tool_choice` | `"auto"` (고정) |
| `max_tokens` | parse `KILN_MAX_TOKENS_PARSE`(기본 2048), judge `KILN_MAX_TOKENS_JUDGE`(기본 1024). 최소 500 강제 |
| `temperature` | 0 (Kiln "passed through" — 미검증) |
| thinking | `KILN_THINKING_MODE`: `default`=추가 없음 / `kwargs_off`=`chat_template_kwargs:{enable_thinking:false}` / `no_think`=system 끝에 `/no_think`. **어느 쪽이 통하는지 추정 단계** — 키 발급 후 같은 요청의 reasoning 토큰 비교로 확정 (PRD OQ #3) |
| 금지 | `response_format`, `stop`, `parallel_tool_calls`, 강제 `tool_choice` — 테스트로 부재 단언 |

정책 변환 function (`enum`은 레지스트리에서 런타임 생성):

```json
{ "type": "function", "function": {
  "name": "submit_spending_policy",
  "description": "Submit the spending policy extracted from the owner's delegation sentence. Call exactly once. All amounts are integer Korean won (e.g. '20만 원' = 200000).",
  "parameters": { "type": "object", "properties": {
    "total_budget_krw":       { "type": "integer", "description": "Total delegated budget in KRW." },
    "approval_threshold_krw": { "type": "integer", "description": "Per-purchase amount in KRW above which the owner must approve. If not stated, use the total budget." },
    "allowed_merchant_ids":   { "type": "array", "items": { "type": "string", "enum": ["daiso","coupang","gmarket"] }, "description": "Registry ids of the merchants the owner allowed." },
    "unrecognized_merchants": { "type": "array", "items": { "type": "string" }, "description": "Merchant names mentioned by the owner that are not in the registry." },
    "expires_on":             { "type": ["string","null"], "description": "Deadline as YYYY-MM-DD if the sentence states one (resolve relative dates from today's date in the system message), otherwise null." },
    "purpose":                { "type": "string", "description": "Short English summary of what the money is for, max 200 characters." } },
  "required": ["total_budget_krw","approval_threshold_krw","allowed_merchant_ids","expires_on","purpose"] } } }
```

의도 판단 function:

```json
{ "type": "function", "function": {
  "name": "submit_intent_judgment",
  "description": "Report whether one purchase request fits the purpose the owner delegated. Do not judge budget, limits or merchants; code enforces those. Call exactly once.",
  "parameters": { "type": "object", "properties": {
    "fits_purpose": { "type": "boolean", "description": "true if the purchase plausibly serves the delegated purpose." },
    "reason":       { "type": "string",  "description": "One sentence, max 200 characters." } },
  "required": ["fits_purpose","reason"] } } }
```

의도 판단 프롬프트에는 **예산·잔액·한도를 넣지 않는다** (한도는 AI에 맡기지 않는다 — PRD 핵심 가치). 입력: purpose, 위임 원문, 가맹점 이름, 금액, 품목 설명.

#### 응답 처리·재시도

| 상황 | 처리 |
|---|---|
| `tool_calls[0].function.name`이 기대 이름 | `rawArguments` 반환 → 유스케이스가 `JSON.parse` + zod. 실패 → parse: `INVALID_ARGS`(F-01 ②) / judge: `invalid_output` → 대기 |
| tool call 없음 (`finish_reason` `stop`/`length`) | parse: `NO_TOOL_CALL`(F-01 ②, 재요청 안 함) / judge: `invalid_output` → 대기 |
| 429 | `x-ratelimit-reset` 있으면 그 초 + 지터(≤1s) 대기, 없으면 1s·2s·4s(상한 8s) + 지터. 총 시도 4회 |
| 5xx·네트워크 오류·타임아웃(90s) | 지수 백오프, 총 시도 4회 |
| 400·401·402·403·404 | 재시도 안 함. 코드 매핑: 402 → `KILN_CREDIT_EXHAUSTED`(UI에 사유 표시, PRD N-05), 401/403 → `KILN_AUTH`, 그 외 → `KILN_BAD_REQUEST` |
| 헤더 | `.withResponse()`로 `x-neocloud-generation-id` 수집. SDK 자체 재시도는 `maxRetries: 0` (재시도 횟수·대기를 직접 기록하기 위해) |

### 5. 증거 패키지 (`src/core/domain/evidence.ts`)

- 정규화: RFC 8785 JCS (npm `canonicalize`). 해시: `keccak256(stringToBytes(canonical))` (viem). 저장하는 `package_json`은 **정규화된 문자열 그대로**다.
- 순환 방지: 패키지는 tx **전에** 만들고 해시를 tx에 싣는다. tx hash·블록·로그 위치는 해시 대상이 아닌 별도 `anchor`에 둔다 (F-11의 "재계산 해시 = 이벤트 해시"는 package 부분 기준).

```ts
type EvidenceBase = { schema: "agent-spend-evidence/v1"; chainId: number; vault: Hex; createdAt: string };

type KilnRef = { callId: string; provider: "kiln"|"fake"; model: string; generationId: string|null;
                 finishReason: string|null; usage: { promptTokens: number; completionTokens: number;
                 reasoningTokens: number|null; totalTokens: number; costUsd: string|null };
                 rawArguments: string|null };

type EvidencePackage = EvidenceBase & (
 | { kind: "policy_set"; owner: Hex; delegationText: string; kiln: KilnRef | null;
     candidate: unknown /* Kiln 인자 파싱 결과 그대로 */; 
     final: { budget: string; approvalThreshold: string; expiresAt: number; expiresAtSource: "kiln"|"owner";
              maxPerMinute: number; maxPerDay: number; purpose: string;
              merchants: { id: string; displayName: string; address: Hex }[] };
     ownerEdits: string[] /* 소유자가 바꾼 필드명 */; feeBps: number }
 | { kind: "spend_request"; requestId: Hex; policyVersion: string; policyEvidenceHash: Hex;
     request: { merchantId: string; merchantAddress: Hex; amount: string; fee: string; itemDescription: string };
     precheck: { verdict: "pass"|"block"; reason: number|null; expected: "execute"|"pending"|null;
                 snapshot: { blockNumber: string; blockTimestamp: number; remaining: string; paused: boolean;
                             minuteCount: number; dayCount: number } };
     judgment: null | { status: IntentJudgment["status"]; reason: string; kiln: KilnRef };
     submission: { agentReviewRequest: boolean } }
 | { kind: "approval" | "rejection"; requestId: Hex; requestEvidenceHash: Hex; owner: Hex }
 | { kind: "pause" | "unpause"; owner: Hex; note: string /* 0..200자, 빈 문자열 허용 */ }
);

type Anchor = { txHash: Hex; blockNumber: string; logIndex: number; event: string; args: Record<string, string|number|boolean|string[]> } | null;
```

- `candidate`는 Kiln이 준 값, `final`은 소유자가 확인·수정한 값 — 둘을 모두 남겨 "AI가 제안한 것 vs 사람이 서명한 것"을 재구성 가능하게 한다.
- `unknown` 값도 JCS로 정규화 가능한 JSON이어야 한다 (함수·undefined·bigint 금지 — bigint는 문자열로 변환 후 넣는다).

#### 내보내기 파일 (`cli/export-evidence.ts` → `evidence/base-sepolia/evidence.json`)

```json
{ "schema": "agent-spend-evidence-export/v1", "network": "baseSepolia", "chainId": 84532,
  "vault": "0x…", "token": "0x…", "deployBlock": "…", "exportedAt": "ISO",
  "records": [ { "evidenceId": "uuid", "kind": "spend_request", "evidenceHash": "0x…",
                 "package": { … }, "anchor": { … } | null } ],
  "kilnCalls": [ KilnCallRecord, … ] }
```

로컬 체인 내보내기는 `data.local/evidence/localhost/evidence.json` (커밋 안 함).

#### 제3자 검증 스크립트 (`cli/verify-evidence.ts`)

`npx tsx cli/verify-evidence.ts --file <evidence.json> [--rpc https://sepolia.base.org]` — `.env`·SQLite 불필요.

| 검사 | 불일치 판정 |
|---|---|
| H: `keccak256(canonicalize(record.package)) == record.evidenceHash` | 다르면 `HASH_MISMATCH` |
| A: anchor.txHash 영수증 조회 → status success → vault 주소의 logIndex 로그 디코드 → 이벤트 evidenceHash == 재계산 해시 | `TX_NOT_FOUND` / `EVENT_MISMATCH` |
| F: 지출 레코드면 이벤트의 requestId·merchant·amount == package.request | `FIELD_MISMATCH` |
| U: deployBlock부터 vault 로그 전체 조회(청크 10,000블록) → 레코드와 짝이 없는 이벤트 | `UNMATCHED_ONCHAIN_EVENT` |
| R: `replay` — PolicySet부터 순서대로 재생해 각 `SpendExecuted`가 (허용 가맹점 ∧ 누적 spent ≤ budget ∧ 만료 전 ∧ (amount ≤ threshold ∨ 같은 requestId의 `Approved` 존재)) 인지 | `OUT_OF_POLICY` |

출력: 레코드별 표(kind, txHash, 재계산 해시, 온체인 해시, 결과) + 요약 `mismatches: N`. 종료 코드: 0건이면 0, 아니면 1 (F-12 ①②).

### 6. SQLite 스키마 (`src/adapters/db/sqlite.ts`, `PRAGMA user_version = 1`, `journal_mode = WAL`)

```sql
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('policy_set','spend_request','approval','rejection','pause','unpause')),
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL, request_id TEXT,
  package_json TEXT NOT NULL,              -- 정규화 문자열 그대로
  evidence_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  anchor_tx_hash TEXT, anchor_block TEXT, anchor_log_index INTEGER, anchor_event TEXT, anchor_args_json TEXT, anchored_at TEXT
);
CREATE TABLE IF NOT EXISTS kiln_calls (
  call_id TEXT PRIMARY KEY,
  flow TEXT NOT NULL CHECK (flow IN ('policy_parse','intent_judge')),
  provider TEXT NOT NULL CHECK (provider IN ('kiln','fake')),
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL, request_id TEXT,
  model TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('tool_call','no_tool_call','http_error')),
  http_status INTEGER, error_code TEXT, finish_reason TEXT, attempts INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, reasoning_tokens INTEGER,
  total_tokens INTEGER NOT NULL, cached_tokens INTEGER, cost_usd TEXT, generation_id TEXT,
  thinking_mode TEXT NOT NULL, raw_arguments TEXT, raw_content TEXT,   -- raw_content는 4,000자에서 자름
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_requests (
  request_id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL,
  flow TEXT NOT NULL CHECK (flow IN ('rule_block','intent_judge')),
  merchant_id TEXT NOT NULL, amount TEXT NOT NULL, fee TEXT NOT NULL,
  precheck_verdict TEXT NOT NULL, precheck_reason INTEGER, judgment_status TEXT,
  tx_hash TEXT, outcome TEXT CHECK (outcome IN ('executed','blocked','pending','failed')),
  onchain_reason INTEGER, pending_flags INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_events (
  chain_id INTEGER NOT NULL, vault TEXT NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
  block_number TEXT NOT NULL, block_timestamp INTEGER NOT NULL, event_name TEXT NOT NULL,
  request_id TEXT, evidence_hash TEXT, args_json TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS sync_state (chain_id INTEGER NOT NULL, vault TEXT NOT NULL, last_block TEXT NOT NULL, PRIMARY KEY (chain_id, vault));
```

- 모든 쿼리는 파라미터 바인딩만 사용 (문자열 연결 금지 — security-audit 2).
- 한 DB 파일에 여러 배포가 공존할 수 있으므로 모든 조회는 `(chain_id, vault)`로 거른다.
- 흐름별 usage는 `kiln_calls`에서 prompt/completion/reasoning 토큰·cost·Generation-Id를 흐름 라벨과 함께 보관한다.

### 7. Repo 포트 (`src/core/ports.ts`)

```ts
interface VaultReader {
  getState(): Promise<VaultStateSnapshot>;
  remainingBudget(): Promise<bigint>;
  getPending(requestId: Hex): Promise<{ merchant: Hex; amount: bigint; fee: bigint; flags: number; status: number; evidenceHash: Hex }>;
  getReceiptEvents(txHash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; events: DecodedVaultEvent[] } | null>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<DecodedVaultEvent[]>;   // 어댑터가 10,000블록 청크로 나눔
  latestBlock(): Promise<bigint>;
}
interface AgentVaultWriter { spend(a: { requestId: Hex; merchant: Hex; amount: bigint; agentReviewRequest: boolean; evidenceHash: Hex }): Promise<{ txHash: Hex; receipt: { status: "success"|"reverted"; events: DecodedVaultEvent[]; gasUsed: bigint; feeWei: bigint } }>; }
interface OwnerVaultWriter {   // CLI(E2E·unpause) 전용. 브라우저는 지갑이 직접 서명
  setPolicy(p: PolicyValues & { merchants: Hex[] }, evidenceHash: Hex): Promise<TxResult>;
  approve(requestId: Hex, evidenceHash: Hex): Promise<TxResult>;
  reject(requestId: Hex, evidenceHash: Hex): Promise<TxResult>;
  pause(evidenceHash: Hex): Promise<TxResult>;
  unpause(evidenceHash: Hex): Promise<TxResult>;
}
type DecodedVaultEvent = { name: string; txHash: Hex; logIndex: number; blockNumber: bigint; blockTimestamp: number; args: Record<string, unknown> };
interface EvidenceRepo { insert(r: { evidenceId: string; kind: string; chainId: number; vault: Hex; requestId: Hex|null; packageJson: string; evidenceHash: Hex; createdAt: string }): void;
  findByHash(h: Hex): EvidenceRow | null; findById(id: string): EvidenceRow | null; listByRequestId(id: Hex): EvidenceRow[];
  setAnchor(h: Hex, a: NonNullable<Anchor>): void; listByVault(chainId: number, vault: Hex): EvidenceRow[]; }
interface KilnCallRepo { insert(r: KilnCallRecord & { chainId: number; vault: Hex; requestId: Hex|null; status: string; errorCode: string|null; rawArguments: string|null; rawContent: string|null }): void;
  findById(id: string): KilnCallRecord | null; aggregateByFlow(chainId: number, vault: Hex, provider: "kiln"|"fake"): FlowAggregate[]; }
interface SpendRequestRepo { insert(r: SpendRequestRow): void; updateOutcome(requestId: Hex, o: Partial<SpendRequestRow>): void; countByFlow(chainId: number, vault: Hex): { flow: string; n: number }[]; }
interface ChainEventRepo { upsertMany(e: DecodedVaultEvent[], chainId: number, vault: Hex): void; list(chainId: number, vault: Hex): DecodedVaultEvent[];
  findByTx(txHash: Hex): DecodedVaultEvent[]; getSyncBlock(chainId: number, vault: Hex): bigint | null; setSyncBlock(chainId: number, vault: Hex, b: bigint): void; }
interface Clock { now(): Date }

// --- 2026-09-28 보강 (T-03 구현 보고의 미정의 타입 — D-33) ---
type TxResult = { txHash: Hex; receipt: { status: "success"|"reverted"; events: DecodedVaultEvent[]; gasUsed: bigint; feeWei: bigint } };
// AgentVaultWriter.spend 반환형과 동일. feeWei = gasUsed × effectiveGasPrice + (l1Fee ?? 0) — E2E 지갑별 ETH 합계의 입력
type FlowAggregate = {   // KilnCallRepo.aggregateByFlow 한 행 = kiln_calls를 (chain_id, vault, provider)로 거른 뒤 flow GROUP BY (T-06 사용)
  flow: "policy_parse" | "intent_judge"; kilnCalls: number /*COUNT(*) — http_error 행 포함*/;
  promptTokens: number; completionTokens: number; totalTokens: number;   // SUM
  reasoningTokens: number | null;   // SUM — 전부 NULL이면 null (SQLite SUM 의미 그대로)
  costUsd: string;                  // String(TOTAL(CAST(cost_usd AS REAL)))
  latencyMsSum: number;             // 에너지 추정 입력 (latency_ms 합)
  generationIds: string[];          // NULL 제외, created_at 순
};
// ChainEventRepo: args_json 직렬화 시 bigint → {"__bigint":"<10진>"}, 조회 시 bigint로 복원 — reader가 준 DecodedVaultEvent와 같은 타입으로 돌려준다
// processSpendRequest deps = 현재 구현(chainId, vault, deployBlock, reader, writer, kiln, evidence, kilnCalls, spendRequests, merchants, clock) + chainEvents: ChainEventRepo (ADR-0004)
function pullNewEvents(d: { reader: VaultReader; chainEvents: ChainEventRepo; chainId: number; vault: Hex; deployBlock: bigint }): Promise<{ newEvents: number; toBlock: bigint }>;
// from = (getSyncBlock ?? deployBlock − 1) + 1, to = latestBlock(); from > to 이면 0건. getLogs(from,to) → upsertMany(멱등) → setSyncBlock(to).
// 동시 호출로 커서가 뒤로 가도 다음 호출이 재조회·멱등 upsert하므로 무해. syncChainEvents = pullNewEvents + anchor 연결
```

#### 배포 파일·네트워크 (`src/adapters/chain/networks.ts`, T-04)

```ts
type DeploymentFile = {   // deployments/baseSepolia.json(커밋) · data.local/deployments/localhost.json — T-02 LocalDeployment 형식을 network만 넓혀 채택
  network: "localhost" | "baseSepolia"; chainId: number; token: Hex; vault: Hex; owner: Hex; agent: Hex; feeRecipient: Hex;
  feeBps: number; vaultMint: string /*10진*/; deployBlock: number;
};
const NETWORKS: Record<"localhost"|"baseSepolia", { chainId: 31337|84532; deploymentFile: string; explorerTxUrl: string | null }>;
// localhost: 31337, "data.local/deployments/localhost.json", null / baseSepolia: 84532, "deployments/baseSepolia.json", "https://sepolia.basescan.org/tx/"
// RPC는 env RPC_URL. viem chain 객체는 viem/chains의 hardhat·baseSepolia에 RPC_URL을 덮어쓴다
```

### 8. 유스케이스 시그니처

```ts
parsePolicy(deps, i: { delegationText: string /*1..500자*/ }):
  Promise<{ ok: true; parseCallId: string; candidate: PolicyCandidate; warnings: string[] } | { ok: false; code: "NO_TOOL_CALL"|"INVALID_ARGS"|"SCHEMA_INVALID"|"UNKNOWN_MERCHANT"|KilnErrorCode; message: string; parseCallId: string|null }>;
// PolicyCandidate = { budget: bigint; approvalThreshold: bigint; merchantIds: string[]; expiresOn: string|null; purpose: string; unrecognizedMerchants: string[] }

prepareOwnerAction(deps, i:
  | { kind: "policy_set"; owner: Hex; parseCallId: string|null; delegationText: string; final: PolicyValues; expiresAtSource: "kiln"|"owner"; ownerEdits: string[] }
  | { kind: "approval"|"rejection"; owner: Hex; requestId: Hex }
  | { kind: "pause"|"unpause"; owner: Hex; note: string }):
  Promise<{ evidenceId: string; evidenceHash: Hex; call: { functionName: "setPolicy"|"approve"|"reject"|"pause"|"unpause"; args: unknown[] } }>;
// owner != vault.owner 이면 NOT_OWNER 에러 (UI 가드용 — 최종 권한은 컨트랙트)

processSpendRequest(deps, i: SpendRequestInput): Promise<SpendOutcome>;
confirmOwnerAction(deps, i: { evidenceId: string; txHash: Hex }): Promise<{ status: "anchored"|"reverted"; events: DecodedVaultEvent[] }>;
// evidenceId의 kind가 policy_set|approval|rejection|pause|unpause가 아니면 NOT_FOUND. 영수증은 기다리지 않고 syncChainEvents로 확인(D-23)
listActivity(deps: { chainId: number; vault: Hex; chainEvents: ChainEventRepo; evidence: EvidenceRepo; merchants: MerchantEntry[] }): ActivityItem[];
// 캐시(ADR-0004)만 읽는다 — 호출 전 syncChainEvents 선행은 호출자 책임
syncChainEvents(deps): Promise<{ newEvents: number; anchored: number; toBlock: bigint }>;
verifyTx(deps, txHash: Hex): Promise<AuditResult>;
buildReceipt(deps, requestId: Hex): Promise<Receipt | null>;
buildEfficiencyReport(deps): Promise<EfficiencyReport>;
```

### 9. HTTP API (Next Route Handler, 전부 서버 전용, 응답은 JSON, bigint → 10진 문자열)

실패 응답 공통형: `{ ok: false, error: { code: string, message: string } }` (스택·내부 메시지 미노출).

| 메서드·경로 | 요청 | 성공 응답 | 사용 화면 |
|---|---|---|---|
| `POST /api/policy/parse` | `{ delegationText }` | `{ ok:true, parseCallId, candidate, warnings, usage }` | ① |
| `POST /api/owner-actions/prepare` | `prepareOwnerAction` 입력(금액 문자열) | `{ ok:true, evidenceId, evidenceHash, call, vault, chainId }` | ①② |
| `POST /api/owner-actions/confirm` | `{ evidenceId, txHash }` | `{ ok:true, status, events }` — `status`는 `"anchored"` 또는 `"reverted"` | ①② |
| `GET /api/vault/state` | — | `{ ok:true, chainId, vault, token, owner, agent, feeBps, explorerTxUrl, state: VaultStateDTO }` | ①② |
| `GET /api/vault/activity` | — (호출 시 `syncChainEvents` 선행) | `{ ok:true, items: ActivityItem[] }` — `ActivityItem = { requestId, kind, merchantId, amount, fee, reason, flags, txHash, blockTimestamp, judgmentStatus }`, `kind` ∈ executed · blocked · pending · approved · rejected · paused · unpaused · policy_set | ② |
| `GET /api/receipts/[requestId]` | — | `{ ok:true, receipt: { amount, fee, merchant, txHash, evidenceHash, judgmentSummary, viaApproval, approver } }` (F-10 6항목) | ② |
| `GET /api/audit/[txHash]` | — | `{ ok:true, result: AuditResult }`, 기록 없으면 `{ ok:true, result:{ status:"not_found" } }` | ③ |
| `GET /api/efficiency` | — | `{ ok:true, report: EfficiencyReport }` | ④ |

```ts
type AuditResult =
  | { status: "not_found" }
  | { status: "found"; txHash: Hex; blockNumber: string; items: { event: string; args: Record<string,unknown>;
      evidenceKind: string|null; package: unknown|null; recomputedHash: Hex|null; onchainHash: Hex;
      hashMatch: boolean|null /* null = 로컬 증거 없음 */; withinPolicy: boolean|null; blockReason: string|null; approver: Hex|null }[] };

type EfficiencyReport = {
  provider: "kiln"|"fake";
  rows: { flow: "policy_parse"|"intent_judge"|"rule_block"; kilnCalls: number; requests: number;
          promptTokens: number; completionTokens: number; reasoningTokens: number|null; totalTokens: number;
          costUsd: string; generationIds: string[]; energyWhUpper: number }[];
  totals: { kilnCalls: number; promptTokens: number; completionTokens: number; reasoningTokens: number|null; totalTokens: number; costUsd: string; energyWhUpper: number };
  savings: { ruleBlockedRequests: number; avoidedTokensEstimate: number; avoidedEnergyWhUpper: number };  // 규칙 차단 건수 × intent_judge 평균
  energy: { formula: string; assumptions: { name: string; value: number; unit: string; source: string }[]; disclaimer: string };
};
```

### 10. 화면 메커니즘 (PRD "화면" 4개)

| 항목 | 결정 |
|---|---|
| 라우팅 | App Router 경로 `/delegate`, `/dashboard`, `/audit?tx=0x…`, `/efficiency`. `/`는 `/dashboard`로 리다이렉트. 공용 `NavBar`(4링크 + 지갑 연결 버튼)는 `app/layout.tsx` |
| 페이지 형태 | 4개 모두 클라이언트 컴포넌트 + Route Handler JSON 호출 (한 가지 패턴으로 통일). 서버 컴포넌트에서 DB 직접 읽기 금지 |
| 서버 데이터 상태 | `useApi<T>(url, {pollMs?})` 훅이 `{status, data, error}` 보유(`status` ∈ idle · loading · success · error). 대시보드는 5초 폴링 + 서명 완료 직후 즉시 재조회. 전역 스토어 없음 |
| 지갑 상태 | `WalletProvider`(React context): EIP-1193 `window.ethereum` + viem `createWalletClient({transport: custom(...)})`. `{status, address, chainId}`(`status` ∈ no_wallet · disconnected · connected), `accountsChanged`/`chainChanged` 구독. wagmi 미사용 (D-15) |
| 권한·네트워크 가드 | `WalletGate`: 연결 주소 == `vault/state.owner` 그리고 chainId == 서버 chainId 일 때만 자식(서명 버튼) 활성. 아니면 사유 표시 — "Connect wallet" / "Switch to Base Sepolia"(버튼: `wallet_switchEthereumChain`, 실패 시 `wallet_addEthereumChain`) / "Connected address is not the owner (view only)" |
| 서명 흐름 | `useOwnerAction()` 상태기계: `idle → preparing → simulating → awaiting_signature → confirming → done`, 어느 단계에서든 `error`로 전이. simulate는 브라우저 지갑 transport로 `simulateContract`해 커스텀 에러를 서명 전에 사람이 읽는 문구로 변환. 사용자 거절(EIP-1193 code 4001) → "Signature rejected" |
| 위임 화면 상태 | `useReducer` 상태기계: `empty → parsing → parsed(candidate, warnings)` 또는 `parse_error(code)`, `parsed → preparing/signing(useOwnerAction) → registered(txHash)`. 빈 값: 문장 미입력이면 Parse 버튼 비활성 + 안내 |
| 대시보드 구성 | `BudgetSummary`(예산·spent·reserved·remaining·수수료율·paused 배지) / `PendingInbox`(Approve·Reject — WalletGate 안) / `ActivityList`(ReasonBadge, TxHashLink) / `PauseButton`(WalletGate 안) / `ReceiptDialog`(선택된 requestId → `/api/receipts/[id]`). 정책 미등록(`policyVersion==0`)이면 "Delegate first" 링크 |
| 감사 화면 | 입력값을 `?tx=` 쿼리로 반영(공유 가능 URL) → `/api/audit/[tx]`. 형식 오류(`^0x[0-9a-fA-F]{64}$` 불일치)는 요청 전 입력 에러 |
| 효율 화면 | `/api/efficiency` 1회 조회. 행 0개면 0 행 표 + "No Kiln calls recorded". `provider:"fake"` 데이터면 "Simulated (fake Kiln) data" 경고 배너 |
| 재사용 컴포넌트 | `AsyncView`(loading/empty/error 렌더 공통), `TxHashLink`(익스플로러 링크), `Krw`(원화 포맷), `ReasonBadge`(코드→라벨, `reasons.ts` 공유) |
| 출력 안전 | Kiln 텍스트·위임 문장은 React 텍스트 노드로만 렌더 (`dangerouslySetInnerHTML` 금지) |
| 시각 디자인 | 설계 대상 아님 — 구현 단계 재량 (Tailwind 사용 여부 포함) |

### 계층 규칙 (DB·외부 API가 있는 프로젝트만 — 없으면 "해당 없음" 기재)

기준은 `.agents/skills/clean-architecture/SKILL.md`. 이 프로젝트에 적용할 결정만 아래에 적는다.

| 항목 | 결정 |
|---|---|
| 의존성 방향 | Domain ← Use case ← Adapter ← Framework (역방향 금지). 구체적으로 `core/domain` ← `core/usecases` ← `adapters/*`, `app/api`, `cli` ← `server/container`, `cli/_container`. `core/**`에서 `next`, `react`, `better-sqlite3`, `openai`, `src/adapters/**`, `src/server/**`, `src/config/env`·`src/config/merchants` import 금지 |
| core 허용 import (D-29) | `zod`, `canonicalize`, viem **순수 유틸만**(`keccak256`, `stringToBytes`, `bytesToHex`, `getAddress` — I/O 없는 함수. `createPublicClient` 등 클라이언트·transport 금지), `@/config/constants`(리터럴만 담고 자신은 아무것도 import하지 않는 모듈 — 값 단일 원본 규칙 유지). 가맹점 목록은 import하지 않고 `deps.merchants`로 주입 |
| Repository 포트 | `src/core/ports.ts`(7절). 구현은 `src/adapters/db/*`, `src/adapters/chain/viemVault.ts`, `src/adapters/kiln/*`. 유스케이스는 `deps` 객체로 포트를 주입받는다 (클래스 DI 컨테이너 없음 — 합성 루트 함수 2개) |
| DTO ↔ 도메인 변환 위치 | Route Handler(`src/app/api/**`)와 CLI 인자 파서. 외부 입력의 bigint↔문자열, 주소 형식 검증·체크섬 변환은 여기서만. 예외: 증거 패키지를 만드는 core는 "주소는 JSON에서 체크섬" 규칙을 지키려고 `getAddress`로 정규화한다(D-29). DB 행 ↔ 도메인 변환은 Repo 구현 안 |
| 순환 의존성 | 금지 |

## 테스트 전략

케이스 도출·부실 테스트 방지 기준은 `.agents/skills/tdd-practitioner/SKILL.md`를 따른다 (정상 1 + 경계 2 + 예외 2 이상, 실제 값 단언, 비동기 대기, 외부 의존성 격리). 아래에는 이 프로젝트의 선택만 적는다.

| 항목 | 결정 |
|---|---|
| 테스트 프레임워크 | ① 컨트랙트: Hardhat 2 테스트 러너(mocha+chai, `hardhat-toolbox-viem`) ②③ TS: Vitest (단위·통합 설정 파일 분리) ④ E2E: `cli/e2e.ts`(tsx 실행 스크립트, 단언 실패 시 종료 코드 1) |
| 테스트 디렉토리 배치 | ① `chain/test/*.test.ts` ② `tests/unit/*.test.ts` ③ `tests/integration/*.test.ts` + `tests/integration/setup/hardhat-node.ts`(globalSetup: `chain/`에서 `npx hardhat node --port 8546` 기동, 포트 응답 대기, 종료 시 kill. 잠금 파일로 동시 실행을 한 번에 하나씩 돌리고, 자기 노드가 포트를 잡았는지 확인한다) ④ `cli/e2e.ts`. 공용 판정 케이스 `tests/fixtures/rule-cases.json`을 ①②가 함께 읽는다(패리티) |
| 커버 범위 기준 | 커버리지 % 목표 없음. **PRD 승인 기준 1개당 테스트 1개 이상**을 아래 매핑으로 강제 |
| Mock/Stub 대상 (외부 의존성) | Kiln → `FakeKilnClient`(②③④-local). 체인 → Mock 없음, 실제 Hardhat 노드(③④-local) / Hardhat 내장 네트워크(①). SQLite → 실제 better-sqlite3, 테스트마다 `:memory:` 또는 임시 파일. 시계 → `Clock` 포트 주입, 체인 시간은 `evm_increaseTime`+`evm_mine` |

| 계층 | 명령 (T-01이 등록·검증) | 대상 승인 기준 |
|---|---|---|
| ① 컨트랙트 단위 | `npm run test:contracts` (= `npm --prefix chain test` = `hardhat test`) | F-03 ①②③④, F-04 ①②③, F-05 ①②③, F-06 ①, F-08, F-09(컨트랙트), 사유 코드·이벤트 필드·evidenceHash, reject·setPolicy 제약, rule-cases 패리티 |
| ② 단위 | `npm run test:unit` (= `vitest run`) | precheck(rule-cases 패리티 포함), quoteFee 경계(99/100/101원), 정책 zod 검증, 만료일→KST 23:59:59 변환, canonicalize+keccak 고정 벡터, `buildChatBody`(F-01 ③: response_format·stop 부재, description 존재, tool_choice "auto", max_tokens ≥ 500), 재시도 정책(429 reset 헤더/지수 백오프/402 무재시도 — 가짜 fetch), replay 판정 |
| ③ 통합 (Fake Kiln + 실제 노드 + SQLite) | `npm run test:int` (= `vitest run --config vitest.integration.config.ts`) | F-01 ①②, F-04 ④, F-06 ②(Kiln 0회·tx 정확히 1개·SpendBlocked), F-07 ①②③, F-09 사전 검사, F-11 ①②(재해시 = 이벤트 해시), F-14 ③(합계 = SQLite 합), verifyTx 변조 탐지 |
| ④ E2E (로컬) | `npm run chain:node`(별도 터미널) 후 `npm run e2e:local` | F-15 ①, F-12 ①(로컬 내보내기 → verify) |
| ④ E2E (Base Sepolia) | `npm run e2e:sepolia` → `npm run evidence:export -- --chain baseSepolia` → `npm run evidence:verify -- --file evidence/base-sepolia/evidence.json` | F-15 ②, F-12 ① — 테스트가 아니라 제출 증거 생성 (실제 Kiln) |
| 전체 | `npm test` (= contracts → unit → int 순차) | — |
| 화면 | 자동 테스트 없음. DoD 화면 AC는 Browser pane 실물 확인 | F-01 화면, F-02, F-04 ②, F-05 ①, F-10, F-13, F-14 ①② |

T-01 범위: 두 패키지 설치, Hardhat 설정(`paths.artifacts`/`cache` → `build/`), Vitest 2개 설정, 러너당 스모크 테스트 1개(Hardhat 1 + Vitest 1 — 두 러너가 각각 동작함을 보이는 최소 단위), `.env.example` 변수 목록 반영, 위 명령을 CodingRules "검증된 명령어"에 등록. 통합 러너의 노드 자동 기동은 T-03에서 처음 필요하므로 T-01에서는 설정 파일만 만든다.

CI: **제안 — 사용 안 함** (OQ #14, 사용자 확인 필요. 반대 선택 시 T-01에 `.github/workflows/test.yml`: ubuntu-latest, Node 22, `npm ci` ×2, `npm test`).

### E2E 시나리오 (`cli/e2e.ts`, 로컬·Base Sepolia 공통 — F-15)

`--chain localhost|baseSepolia`, `--kiln fake|real`, `--deploy`(새 배포, 로컬은 항상). 각 단계 결과를 `SpendOutcome` 단언으로 확인하고, 실패하면 즉시 종료 코드 1.

| 단계 | 행위자 | 입력 (기본 정책: 예산 200,000 / 임계 50,000 / daiso·coupang / 기한 = 오늘+7일 KST / 분 3·일 20 / 수수료 1%) | 기대 결과 |
|---|---|---|---|
| 0 | 배포자(=agent 키) | MockKRWT·PolicyVault 배포, vault에 1,000,000 mKRW mint | `deployments/*.json` 기록 |
| 1 | Kiln + owner | 예문 "행사비 20만 원을 맡길게, 다이소·쿠팡만, 건당 5만 원 넘으면 물어봐" → parsePolicy → 기한은 소유자 입력(스크립트 값) → setPolicy | `PolicySet`, 발신자 owner |
| 2 | agent | daiso 30,000 "Balloons and table decorations for the welcome party" | Kiln 1회, `SpendExecuted`, 잔여 169,700 |
| 3 | agent | gmarket 20,000 "Snacks" | Kiln 0회, `SpendBlocked(6)` |
| 4 | agent → owner | coupang 60,000 "Portable speaker for the event" | Kiln 1회, `SpendPending(flags 1)` → owner approve → `Approved`+`SpendExecuted(viaApproval)`, 잔여 109,100 |
| 5 | agent | daiso 15,000 "Personal gaming mouse" | Kiln 1회(mismatch), `SpendPending(flags 2)` — 대기 상태로 남김(UI 승인 대기함 시연용), 잔여 93,950 |
| 6 | agent | coupang, amount = **현재 잔여 전액**, "Banner printing" | Kiln 0회, `SpendBlocked(7)` (a ≤ R 이지만 a + 1% > R) |
| 7 | agent | 새 분 버킷을 기다린 뒤 coupang 1,000 "Paper cups" × 4건을 **동시에**(`Promise.all`, agent 계정은 viem nonceManager) 처리 | 정확히 3건 `SpendExecuted` + 1건 `SpendBlocked(4)` (순서는 단언 안 함). 동시 처리라 사전 검사가 못 잡아 4건 모두 Kiln을 부를 수 있다 — 컨트랙트가 최종 차단한다는 시연이며 해당 건 `precheckAgreed=false`로 기록. 4건의 블록 timestamp가 두 분 버킷에 걸치면 "straddled minute boundary" 출력 후 종료 코드 1(재실행). 순차 처리 대신 동시 처리하는 이유: Base Sepolia에서 Kiln 지연(추정 수~수십 초) × 3회가 60초를 넘으면 버킷이 바뀌어 차단이 재현되지 않음. (F-08 — N-02 판정으로 제외 시 `--skip-burst`로 생략) |
| 8 | owner → agent → owner | pause → daiso 5,000 "Tape" → unpause | `VaultPaused`, `SpendBlocked(1)`, `VaultUnpaused` |

- 분 버킷 관리: 단계 2~6, 8 앞에서 `ensureMinuteCapacity(1)`, 7 앞에서 `waitForFreshMinute()`. 로컬은 `evm_increaseTime(60)`+`evm_mine`, Base Sepolia는 최신 블록 timestamp가 다음 분 경계를 넘을 때까지 3초 간격 폴링.
- 실행 로그: 단계별 `{step, actor, requestId, txHash, explorerUrl, event, reason, flags, kilnCalls, tokens, generationId, gasUsed, feeWei}`를 표로 stdout 출력 + `evidence/base-sepolia/run-<ISO>.json`(로컬은 `data.local/…`) 저장. 마지막에 지갑별 ETH 소모 합계 출력.
- 로컬 계정: Hardhat 노드의 `eth_accounts` 사용(노드가 서명) — 코드에 키·니모닉을 적지 않는다. #0 = 배포자·agent, #1 = owner, fee 수령 = #2.

## 배포

docs/PRD.md의 "배포·운영" 항목이 요구사항이라면, 여기는 그 요구사항을 어떻게 실현하는지 메커니즘을 적는다. 모든 행에 결정 또는 명시적 "해당 없음 — 사유"를 적는다 — 빈칸 금지.

| 항목 | 결정 |
|---|---|
| 호스팅 / 실행 대상 | 노트북 로컬: `npm run build` 후 `npm run start`(= `next start -H 127.0.0.1 -p 3000`), 개발 중 `npm run dev`(= `next dev -H 127.0.0.1`). 루프백에만 바인딩 — Kiln 크레딧을 쓰는 `/api/policy/parse`에 인증이 없으므로 외부 노출 금지 (D-17). 컨트랙트: Base Sepolia (chainId 84532, 익스플로러 `https://sepolia.basescan.org`) |
| 빌드·릴리스 파이프라인 | 수동. 순서: `npm run chain:compile`(컴파일 + `chain:export`로 abi·bytecode를 `src/adapters/chain/generated/`에 기록) → `npm test` → `npm run build`. CI 없음(제안 — OQ #14). README에 문서화(docs 에이전트) |
| 환경과 승격 | 로컬 Hardhat 노드(31337) → Base Sepolia(84532) 2단계. `CHAIN` 변수 하나로 전환. 승격 = `npm run deploy -- --chain baseSepolia`(또는 `e2e:sepolia --deploy`) → `deployments/baseSepolia.json` 커밋. 배포 경로는 `cli/deploy.ts`(viem + `generated/` abi·bytecode, `--chain localhost\|baseSepolia`) 하나로 통일 — T-02의 `chain/scripts/deploy-local.ts`·`npm run chain:deploy:local`은 T-04에서 이것으로 대체·제거 (D-30) |
| 환경별 설정 | 아래 `.env.example` 변수 표. 배포 주소는 env가 아니라 `deployments/baseSepolia.json`(커밋) / `data.local/deployments/localhost.json`(로컬). 브라우저는 env를 읽지 않고 `/api/vault/state`에서 chainId·vault 주소를 받는다 (`NEXT_PUBLIC_*` 변수 없음) |
| DB·상태 마이그레이션 | SQLite는 앱·CLI 시작 시 `CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` 확인. 버전 불일치 시 시작 거부 + "delete data.local/app.sqlite and rerun E2E" 안내 (해커톤 기간 중 자동 마이그레이션 없음). 온체인 상태는 불변 — 컨트랙트 변경은 새 배포(새 주소) |
| 롤백 절차 | 앱: `git revert <커밋>` → `npm run build` → 재시작 (약 3분). 컨트랙트: 이전 주소가 담긴 `deployments/baseSepolia.json`을 git에서 되돌리면 앱이 이전 vault를 가리킨다 (약 1분). 이미 쓰인 온체인 기록·내보낸 증거는 되돌리지 않는다 |
| 헬스체크 / 스모크 테스트 | 로컬 릴리스: `npm run e2e:local` 종료 코드 0. Base Sepolia: `npm run evidence:verify -- --file evidence/base-sepolia/evidence.json`의 `mismatches: 0`. 상시 헬스 엔드포인트는 해당 없음 — 로컬 단일 사용자 데모 |
| 운영 규칙 — 제출 증거 대상 DB (사용자 결정, 코드로 강제되지 않음) | 제출용 증거는 CLI(`e2e:sepolia --deploy`)가 새 vault와 전용 DB로 만든 것만 내보낸다. UI 시연은 별도 `DATABASE_PATH`를 쓴다 — 서명 거절로 anchor 없는 owner 증거가 섞이면 verify에서 TX_NOT_FOUND 불일치로 세어진다(D-23, 의도된 동작이지 결함이 아님) |

### `.env.example` 변수 목록 (T-01에서 implementer가 플레이스홀더로 반영 — 이 문서 자체는 .env.example을 수정하지 않는다)

| 변수 | 사용 프로세스 | 예시 플레이스홀더 | 비고 |
|---|---|---|---|
| `CHAIN` | 서버·CLI | `localhost` | `localhost` \| `baseSepolia` |
| `RPC_URL` | 서버·CLI | `http://127.0.0.1:8545` | Base Sepolia는 `https://sepolia.base.org` 또는 키가 박힌 사설 RPC(그 경우 시크릿) |
| `DATABASE_PATH` | 서버·CLI | `data.local/app.sqlite` | `.gitignore`의 `*.local`로 제외되는 경로 유지. `e2e:local`은 `data.local/e2e-localhost.sqlite`를 매 실행 새로 만든다 |
| `KILN_MODE` | 서버·CLI | `fake` | `fake` \| `real`. 키 발급 전 `fake` |
| `KILN_API_KEY` | 서버·CLI | `sk-bk-your-kiln-key-here` | 시크릿. 서버 전용 (`NEXT_PUBLIC_` 금지) |
| `KILN_BASE_URL` | 서버·CLI | `https://api.bricksum.com/v1` | SDK가 경로를 붙이므로 `/chat/completions`를 넣지 않는다 (K) |
| `KILN_MODEL` | 서버·CLI | `qwen3-32b` | 최종 제출물은 이 값 고정 (PRD N-03) |
| `KILN_THINKING_MODE` | 서버·CLI | `default` | `default` \| `kwargs_off` \| `no_think` |
| `KILN_MAX_TOKENS_PARSE` | 서버·CLI | `2048` | 500 미만이면 시작 거부 |
| `KILN_MAX_TOKENS_JUDGE` | 서버·CLI | `1024` | 500 미만이면 시작 거부 |
| `AGENT_PRIVATE_KEY` | **CLI만** — 파일 **`.env.cli`** (ADR-0005) | `0xyour-agent-test-wallet-private-key` | 시크릿. Base Sepolia 배포자 겸 agent. `CHAIN=localhost`면 무시 |
| `OWNER_PRIVATE_KEY` | **CLI만** (`e2e:sepolia`, `owner-unpause`) — 파일 **`.env.cli`** (ADR-0005) | `0xyour-owner-test-wallet-private-key` | 시크릿. 브라우저 지갑과 **같은 테스트 전용 계정**. 서버는 로드하지 않음 |
| `OWNER_ADDRESS` | CLI(deploy) | `0xYourOwnerWalletAddress` | 배포 시 vault owner. OWNER_PRIVATE_KEY와 불일치하면 E2E 시작 거부 |
| `FEE_RECIPIENT_ADDRESS` | CLI(deploy) | `0xYourFeeRecipientAddress` | 플랫폼 수수료 수령 주소(키 불필요) |

env 모듈 분리 (ADR-0005 — `server-only` 패키지는 `react-server` 조건이 없는 Node(tsx·Vitest)에서 import 즉시 throw하므로 CLI·테스트가 import하는 모듈에 두지 않는다):

| 파일 | 내용 | import하는 쪽 |
|---|---|---|
| `src/config/env.ts` | zod 스키마 `serverEnvSchema`(`*_PRIVATE_KEY`·`OWNER_ADDRESS`·`FEE_RECIPIENT_ADDRESS` 없음), `cliEnvSchema`(= server + 그 4개, 전부 optional — `CHAIN=baseSepolia`일 때만 필수로 refine), 순수 함수 `parseServerEnv(src)`·`parseCliEnv(src)`. `server-only` 없음, import 시 `process.env`를 읽지 않음 | `server/env.ts`, `cli/_env.ts`, 단위 테스트 |
| `src/server/env.ts` | `import "server-only"`. `process.env`에 `AGENT_PRIVATE_KEY` 또는 `OWNER_PRIVATE_KEY`가 있으면 "move private keys to .env.cli" 에러로 시작 거부(D-16 강제). 아니면 `parseServerEnv(process.env)` | `server/container.ts`만 |
| `cli/_env.ts` | `process.loadEnvFile(".env")` 후 `process.loadEnvFile(".env.cli")`(각각 파일 없으면 건너뜀) → `parseCliEnv(process.env)` | `cli/_container.ts`만 |

- 개인키는 `.env`가 아니라 **`.env.cli`**에 둔다: Next.js는 `.env`·`.env.local`·`.env.[mode]`·`.env.[mode].local`을 서버 `process.env`에 자동 로드하므로 `.env`에 키를 두면 D-16이 깨진다(Next 로드 대상 목록은 추정 — 확인: `npm run dev` 기동 로그의 `Environments:` 줄에 `.env.cli`가 없어야 한다). `.env.cli`는 기존 `.gitignore`의 `.env.*`로 제외된다. `.env.example`에는 두 키를 "`.env.cli`에 넣을 것" 주석과 함께 둔다.
- 테스트(①②③, e2e:local)는 `.env`·`.env.cli` 없이 돌아야 한다.

### Base Sepolia ETH 소모 추정 (N-02 ETH 확보 판정용 — 전부 추정)

| 항목 | tx 수 / E2E 1회 | 가스 (추정) | 지불 지갑 |
|---|---|---|---|
| 배포 MockKRWT + PolicyVault + mint | 3 | 약 3.92M — **로컬 실측**(T-02, 옵티마이저 꺼짐, 인용). 최초 추정 3.3M 대비 +19% | agent |
| setPolicy / approve / pause / unpause | 4 | 약 0.45M | owner |
| spend: 실행 4(2단계 + 7단계 3회), 대기 2, 차단 4 | 10 | 약 1.3M — T-02 로컬 테스트 spend 평균 130,173 × 10 (인용, 경로 구성이 E2E와 달라 추정) | agent |
| 합계 | **17** | **약 5.7M** | agent 약 5.2M, owner 약 0.45M |

- 가스 가격 0.1 gwei 가정(추정 — Base Sepolia는 대개 이보다 낮지만 급등 가능) 시 E2E 1회 ≈ 0.0006 ETH + L1 데이터 수수료. 실측 반영 후에도 이어지는 권장 확보량의 1/10 미만이므로 권장량은 유지한다. 옵티마이저는 켜지 않는다 (D-34). **권장 확보량: agent 0.01 ETH, owner 0.005 ETH** (E2E 재실행·UI 시연 여유 10회분 이상, 추정).
- 확인 방법: 첫 `e2e:sepolia` 실행 로그의 지갑별 `Σ(gasUsed × effectiveGasPrice + l1Fee)` 합계(E2E가 출력). 추정과 2배 이상 다르면 N-02 판정에 실측값을 쓴다.
- 사전 차단도 tx가 생기므로(ADR-0002) 차단 1건 ≈ 5~7만 가스(추정)가 agent에서 나간다.

## 에러 처리

전역 전략이다 — 기능별 메모가 아니다. 모든 행에 결정 또는 명시적 "해당 없음 — 사유"를 적는다.

| 항목 | 결정 |
|---|---|
| 예외를 잡는 위치 | 도메인은 예상된 실패를 **결과값**(`{ok:false, code}`, `PrecheckResult`, `IntentJudgment.status`)으로 반환하고 던지지 않는다. 체인·DB 어댑터는 외부 오류를 `AppError{code, message, retryable, cause}`(`src/core/errors.ts`)로 감싸 던진다. **Kiln 어댑터는 예외다 — HTTP·네트워크 실패를 던지지 않고** 재시도 소진 후 `KilnCallResult.outcome = {kind:"http_error", status, code: KilnErrorCode\|null}`로 반환한다(4절, D-32). 유스케이스가 이 반환값을 매핑한다: `processSpendRequest`는 `interpretIntentOutcome`으로 `judgment.status="error"`(reason = 코드) → `agentReviewRequest=true` 대기 경로(D-10), `parsePolicy`는 `{ok:false, code}`. 최종 포착은 Route Handler(요청당 try/catch 1개)와 CLI main(종료 코드 1). 유스케이스는 AppError를 잡지 않고 통과시킨다 — 예외: `processSpendRequest`는 `writer.spend` 실패 시 `spend_requests.outcome="failed"`를 기록한 뒤 다시 던진다 |
| 실패가 사용자에게 드러나는 방식 | Route Handler가 `AppError.code` → HTTP 상태: `VALIDATION_FAILED`/`SCHEMA_INVALID`/`NO_TOOL_CALL`/`INVALID_ARGS`/`UNKNOWN_MERCHANT`/`EXPIRY_REQUIRED`→400·422, `NOT_OWNER`→403, `NOT_FOUND`→404, `KILN_RATE_LIMITED`→429, `KILN_CREDIT_EXHAUSTED`→402, `KILN_UNAVAILABLE`/`KILN_AUTH`/`KILN_BAD_REQUEST`/`CHAIN_RPC_ERROR`→502, 그 외→500(`INTERNAL`, 메시지 일반화). `POLICY_EVENT_NOT_FOUND`/`POLICY_EVIDENCE_NOT_FOUND`는 `processSpendRequest`(HTTP 경로 없음) 전용 — CLI 종료 코드 1 + 코드 출력. UI는 코드별 영어 문구 표(`src/ui/errorMessages.ts`)로 표시. 지갑 오류(4001 거절, 잘못된 체인, 컨트랙트 커스텀 에러)는 클라이언트에서 같은 표로 변환 |
| 경계 간 전파 | 컨트랙트 → TS: 정책 위반은 revert가 아니라 이벤트(ADR-0002)이므로 **정상 결과**로 전파. revert(권한·중복 등)만 `CHAIN_TX_REVERTED`. Kiln → 유스케이스: `KilnCallResult.outcome`(throw 안 함, 재시도 소진 후 `http_error`). API → UI: `{ok:false, error:{code,message}}` 한 형태. 스택 트레이스·원본 에러 메시지·RPC URL은 응답에 싣지 않는다 |

## 관측성

모든 행에 결정 또는 명시적 "해당 없음 — 사유"를 적는다.

| 항목 | 결정 |
|---|---|
| 로깅 | `src/core`는 로깅하지 않음. 어댑터·Route Handler·CLI가 한 줄 JSON을 stdout으로(`{ts, level, event, ...fields}`): Kiln 호출(flow, status, attempts, tokens, generationId, latencyMs), tx 전송·결과(txHash, event, reason), 에러(code). 로그 금지 항목: 키·`RPC_URL`·`.env` 값 전체, Authorization 헤더. 위임 문장·품목 설명은 200자에서 자름. E2E 실행 로그 파일은 "E2E 시나리오" 절 |
| 에러 추적 / 모니터링 | 없음 — 로컬 단일 사용자 데모, 로그로 대체 |
| 메트릭 | 운영 메트릭 없음. 도메인 지표(흐름별 토큰·cost·호출 수·에너지 추정)는 SQLite `kiln_calls`가 원본이고 효율 리포트가 표시한다 |

### 에너지 추정 가정 (F-14 ② — 제안, OQ #9 사용자 확인 필요)

측정값이 아니다 — 화면과 README에 "estimate (assumed), not measured"를 표시한다. 값은 `src/config/constants.ts`의 `ENERGY_ASSUMPTIONS`에 출처 문자열과 함께 둔다.

| 항목 | 제안값 | 출처·근거 |
|---|---|---|
| 식 | `E_Wh(호출) = latency_s × cards × P_card_W ÷ 3600` (상한) | 호출 지연 동안 카드 전력 전부를 이 요청에 귀속 — 서버 배치 공유를 무시하므로 **상한(upper bound)** |
| `P_card_W` | 180 W | FuriosaAI RNGD 공개 TDP (추정 — 제품 페이지 확인 필요) |
| `cards` | 2 | qwen3-32b BF16 가중치 약 64 GB > RNGD 1장 HBM 48 GB → 최소 2장 (추정 — Kiln 측 실제 구성 미공개) |
| `latency_s` | 우리 클라이언트가 잰 `latency_ms / 1000` (재시도 대기 제외, 마지막 성공 시도만) | 실측 |
| 절감 추정 | `규칙 차단 건수 × intent_judge 평균 E_Wh` / 토큰도 같은 방식 | 규칙 차단 흐름은 호출 0회 = 실측 0 |

## 주요 결정

결정 기록은 [DECISIONS.md](DECISIONS.md)와 [adr/](adr/)에 있다. 이 문서에는 결과만 반영한다.

| ADR | 제목 |
|---|---|
| [ADR-0001](adr/0001-policyvault-custom-contract.md) | 자체 PolicyVault 컨트랙트 (ERC-4337 스마트 계정 대신) |
| [ADR-0002](adr/0002-block-as-event-and-onchain-precheck-record.md) | 차단은 revert 대신 이벤트 + false, 사전 차단도 온체인 제출 |
| [ADR-0003](adr/0003-evidence-sqlite-json-onchain-hash.md) | 증거 원문 SQLite + JSON 내보내기 + 온체인 해시 (IPFS 대신) |
