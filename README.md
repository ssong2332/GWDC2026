# 곳간지기 (Allowance) — Agent Spending Control & Evidence Layer

GWDC 2026 KOREA 해커톤 챌린지 B 출품작. 동아리·학생회 행사비를 AI 에이전트가 대신 쓸 때, 한도는 코드와 온체인 `PolicyVault`가 강제하고 모든 결제·차단·승인·중지를 제3자가 검증할 수 있게 남긴다.

## Declared function (one sentence) / 선언한 기능 (한 문장)

**EN:** When an AI agent spends event/club budget on a user's behalf, spending limits are enforced by code and the on-chain `PolicyVault` — never by the AI — and every payment, block, approval, and pause is recorded so a third party can reconstruct it from the record alone.

**KR:** AI 에이전트가 동아리·학생회 행사비를 대신 쓸 때, 한도 판정은 AI가 아니라 코드와 온체인 `PolicyVault`가 하고, 모든 결제·차단·승인·중지를 제3자가 기록만으로 재구성할 수 있게 남기는 지출 통제·증거 계층.

## 사용자·문제·AI와 코드의 경계

| 구분 | 내용 |
|---|---|
| 사용자 | 예산을 맡기는 사람(동아리 회장 — 소유자 지갑), 검사하는 사람(감사·회원 — 제3자, 소유자·운영자에게 묻지 않고 공개 기록만으로 각 결제가 허용 범위 안이었는지 재구성), 지출 에이전트(정책 안에서만 결제, 규칙을 스스로 바꿀 수 없음) |
| 문제 | 행사비 지출을 AI에 맡길 때 얼마까지·어디에 쓸 수 있는지를 AI 판단에 맡기면 위험하다 — 한도는 AI가 아니라 코드가 정해야 제3자가 신뢰할 수 있다 |
| AI가 하는 일 (Kiln `qwen3-32b`) | ① 위임 문장(자연어) → 정책 후보(총예산·허용 가맹점·건당 승인 임계·기한) 변환. ② 개별 구매가 위임 목적에 맞는지 판단만 한다 — 예산·한도·가맹점 여부는 판단하지 않는다 |
| 코드·컨트랙트가 강제하는 일 | 총예산, 허용 가맹점, 건당 승인 임계, 기한, 수수료 포함 예산, 호출 폭주 한도(분당·일일), 정지(pause) — 온체인 `PolicyVault.spend()`의 판정 순서(아래)로 고정 |
| AI는 경계를 넓힐 수 없다 | Kiln이 "위임 목적에 맞지 않음"(mismatch)·판단 실패(invalid_output·error)로 답해도 결과는 **승인 대기로만 엄격화**된다(fail-closed) — 코드가 이미 막은 요청을 AI가 통과시키는 경로는 없다 |

## Boundary & where enforced / 경계와 강제 지점

`chain/contracts/PolicyVault.sol`의 `spend()`가 매 요청마다 아래 순서로 판정한다(TS `evaluatePrecheck`가 같은 순서를 미러). 차단(1~8)이 대기(9)보다 우선한다.

| 순서 | 조건 | 결과 (사유 코드) |
|---|---|---|
| 1 | `paused` | 차단 — `PAUSED(1)` |
| 2 | 정책 미등록 (`policyVersion==0`) | 차단 — `NO_POLICY(2)` |
| 3 | 기한 경과 | 차단 — `EXPIRED(3)` |
| 4 | 분당 호출 한도 초과 | 차단 — `RATE_LIMIT_MINUTE(4)` |
| 5 | 일일 호출 한도 초과 | 차단 — `RATE_LIMIT_DAY(5)` |
| 6 | 비허용 가맹점 | 차단 — `MERCHANT_NOT_ALLOWED(6)` |
| 7 | 수수료 포함 금액이 잔여 예산 초과 | 차단 — `OVER_BUDGET(7)` |
| 8 | vault 잔액 부족 | 차단 — `INSUFFICIENT_VAULT_BALANCE(8)` |
| 9 | 임계 초과 또는 AI 목적 불일치(`agentReviewRequest`) | 대기 — `SpendPending`(소유자 승인 필요) |
| 10 | 그 외 | 실행 — `SpendExecuted` |

차단·대기는 revert가 아니라 이벤트(`SpendBlocked(reason)`/`SpendPending(flags)`)로 기록되고 tx는 성공(mined)한다 — 사전 검사(코드)가 막은 요청도 같은 인자로 PolicyVault에 제출해 온체인에 남긴다.

## How the chain is used / 체인 사용 방식

Base Sepolia, 컨트랙트 `chain/contracts/PolicyVault.sol`. 정산 자산은 vault가 보유한 ERC20(`MockKRWT`)이다.

| 주체 / Actor | Reads / 읽는 것 | Writes / 쓰는 것 | Settles / 정산하는 것 |
|---|---|---|---|
| Agent (지출 에이전트) | 지출 요청마다 `getState()`로 잔여 예산 산출용 값·`paused`·`policyVersion`·기한·호출 카운터·vault 잔액·허용 가맹점을 읽는다 | `spend(requestId, merchant, amount, agentReviewRequest, evidenceHash)` 한 가지뿐 (`onlyAgent`). 사전 검사가 막은 요청도 제출해 `SpendBlocked`/`SpendPending`이 온체인에 남는다 | 직접 정산하지 않는다 — 통과한 `spend()` 안에서 컨트랙트가 가맹점과 수수료 수령 주소로 토큰을 전송한다 |
| Owner (소유자, 브라우저 지갑 서명) | 대시보드용 `getState()`와 이벤트 로그 | `setPolicy`, `approve`, `reject`, `pause`, `unpause` — 서버는 호출 데이터만 준비하고 소유자 지갑이 서명·전송한다 | 승인 대기 건을 `approve()`하면 그 자리에서 정산 + `Approved`·`SpendExecuted` 발행. `reject()`는 예약분만 풀고 이체 없음 |
| Third party (감사자, 키 불필요) | 배포 블록부터 모든 vault 이벤트와 tx 영수증 이벤트를 읽어 증거 JSON의 해시와 대조 | 없음 (읽기 전용) | 없음 — 이벤트에 남은 `SpendExecuted`(금액·수수료·`evidenceHash`)로 정산 결과를 재구성만 한다 |

- AI(Kiln)는 체인 상태를 읽지도 쓰지도 않는다 — 온체인 인자는 `agentReviewRequest`(불리언) 하나로만 반영된다.
- 웹 서버는 개인키를 갖지 않는다: `AGENT_PRIVATE_KEY`/`OWNER_PRIVATE_KEY`가 있으면 시작을 거부한다. 에이전트 `spend()` 서명은 CLI에서만 일어난다.

## 사람이 보는 화면 4개

| 화면 | 경로 | 내용 |
|---|---|---|
| ① 위임 | `/delegate` | 자연어 위임 문장 입력 → Kiln이 만든 정책 후보 확인·수정 → 소유자 브라우저 지갑 서명 |
| ② 대시보드 | `/dashboard` | 잔여 예산·지출 목록, 승인 대기함(승인/거절 서명), 정지(pause) 버튼, 영수증 |
| ③ 감사 | `/audit` | tx hash 입력 → 증거 재구성 + 해시 일치 표시 (제3자가 소유자·운영자 없이 검증) |
| ④ 효율 | `/efficiency` | 흐름별 토큰·cost·호출 수, 규칙 차단으로 아낀 Kiln 호출, 에너지 추정(2장 시나리오) |

화면 언어는 기본 한국어이며 상단 "한국어/English" 버튼으로 전환한다(선택은 쿠키에 저장). 제품명 표시는 한국어 "곳간지기" / 영어 "Allowance". AI가 생성한 문장, 가맹점 이름, 금액 등 데이터 값과 증거 JSON은 번역하지 않는다.

## Base Sepolia evidence / Base Sepolia 실행 증거

배포: `deployments/baseSepolia.json` (chainId 84532, deployBlock 47419193) — vault `0x639d1c2D7b739B2808E92fbdeEEd9Ea5083519f4`, token(MockKRWT) `0x074Aa6a6EE96922553340582d9Ebd08f489E1900`, owner `0xD54EEE304C705659Ddf147fcdcFf2CBDCd2f19cd`, agent `0xE0e93167c04a96547E20A9e69F6Ac66578cfA3AA`.

실행 로그(`evidence/base-sepolia/run-2026-09-28T14-44-28-469Z.json`, 실제 Kiln 8회, 17단계): 각 사건의 tx hash를 BaseScan(`https://sepolia.basescan.org/tx/<hash>`)에서 조회할 수 있다.

| step | event | reason/flag | BaseScan |
|---|---|---|---|
| 1 | PolicySet (owner 서명, Kiln 1회) | — | https://sepolia.basescan.org/tx/0x920cd8f18f675a69773922315f1c865fa6dfbfba2645bf0fe9eb13fa052d3caf |
| 2 | SpendExecuted (정상 결제) | — | https://sepolia.basescan.org/tx/0xb10d84152934531c6cfd8f2f02c69cb34fa20f2abe832e5f659de6e56327b636 |
| 3 | **SpendBlocked — 비허용 가맹점** | reason 6 `MERCHANT_NOT_ALLOWED` | https://sepolia.basescan.org/tx/0x50d6e9ddcb84067bf62d497a753033b7d6bc5a8f605b6a3c13f15bc057dc340c |
| 4 | SpendPending → Approved+SpendExecuted (임계 초과, 승인 흐름) | flag 1 `OVER_THRESHOLD` | https://sepolia.basescan.org/tx/0x1d593749a7d248d8efe52c75284880da44c248c6df81582a3c933a000539b17a → https://sepolia.basescan.org/tx/0x101ee3f86a1bbf7a7c049a71479483107f6572705f312e76ca418d0a1d7d907f |
| 5 | SpendPending (AI 목적 불일치, 승인 대기) | flag 2 `AGENT_REVIEW_REQUEST` | https://sepolia.basescan.org/tx/0x91a2f03e142140b68f81ed61c65ceea80a1fe0b0efbed89a58afed942e803603 |
| 6 | **SpendBlocked — 수수료 포함 예산 초과** | reason 7 `OVER_BUDGET` | https://sepolia.basescan.org/tx/0xfe994667e3f0145cb9d02e5d77fcca37d1d30b1300c69a67ab64eeeee58b15df |
| 7 | **SpendBlocked — 호출 폭주 차단** (동시 4건 중 1건) | reason 4 `RATE_LIMIT_MINUTE` | https://sepolia.basescan.org/tx/0x76aba0eaa63d0e5b254a894ba9dcdbe9d9da2ab8421a9324a6f6c817038d1a1b |
| 8 | VaultPaused (owner) → **SpendBlocked — 정지 중** → VaultUnpaused (owner) | reason 1 `PAUSED` | https://sepolia.basescan.org/tx/0xed174525287f2b995097c80f088a3f03223e51c81070e71c353d63330bfc8774 → https://sepolia.basescan.org/tx/0x0672932208dd01532bdaa5bee95b4882e9931dd47de5bd6e65c042f0abc78922 → https://sepolia.basescan.org/tx/0x975b21728f112a2e2d07bb036eb7e17fe7dca35d5c701b468650252263372755 |

전체 17단계(배포 3건 포함)는 run JSON 원문 참조.

## Verify it yourself (third party) / 제3자 직접 검증

`.env`·API 키·DB·운영자 없이 Base Sepolia 공개 RPC(읽기 전용)만으로 검증할 수 있다. Node.js 22와 npm이 필요하다.

```bash
npm ci
npm run evidence:verify -- --file evidence/base-sepolia/evidence.json
```

기대 결과: `mismatches: 0`(종료 코드 0) — 레코드 14건·온체인 이벤트 15건 전부 `OK`(각 항목의 재계산 해시 = 온체인 해시)(2026-09-29 직접 실행 확인). 증거 JSON을 변조한 사본으로 실행하면 해당 항목이 불일치로 보고된다. 감사 화면(`/audit?tx=<hash>`)은 같은 대조를 tx hash 1건 단위로 브라우저에서 보여준다.

## Efficiency (per flow) / 흐름별 효율

`npm run report:efficiency -- --file evidence/base-sepolia/evidence.json` 결과(2026-09-29 실행). 제출 증거는 Thinking mode `default` 실행분이다.

| flow | Kiln calls | requests | prompt | completion | reasoning | total tokens | cost (USD) | energy est., 2-card scenario (Wh) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| policy_parse | 1 | 1 | 624 | 451 | 367 | 1075 | 0.00017604 | 0.8086 |
| intent_judge | 7 | 7 | 2416 | 1794 | 1497 | 4210 | 0.00062924 | 3.4241 |
| rule_block | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0.0000 |
| total | 8 | - | 3040 | 2245 | 1864 | 5285 | 0.00080528 | 4.2327 |

- **에너지는 추정(2장 시나리오)이며 측정값이 아니다** — 가정: FuriosaAI RNGD 카드 2장 × 180W. Kiln은 qwen3-32b를 몇 장의 카드로 서빙하는지 공개하지 않아 카드 수는 확정할 수 없고, 카드가 더 많으면 값이 비례해 커진다. 지연은 클라이언트가 측정했고 전력·카드 수는 가정이다.
- **불필요한 추론 절감**: 사전검사에서 확정된 요청(`rule_block` 3건)은 Kiln을 0회 호출했다 — `intent_judge` 평균으로 추정하면 약 1,804 토큰·1.4675 Wh(2장 시나리오 추정)를 아꼈다.

## 빠른 시작 (로컬 데모)

Node.js 22, npm. API 키는 필요 없다(가짜 Kiln·로컬 체인). 실제 Kiln 호출은 `.env.example`을 `.env`로 복사해 `KILN_MODE=real`과 `KILN_API_KEY`를 채워야 하며, 실제 값은 커밋하지 않는다.

```bash
# 설치 (루트 + chain 패키지)
npm ci
npm --prefix chain ci

# 1. 로컬 체인 노드 (별도 터미널, 종료 전까지 점유)
npm run chain:node

# 2. 배포 (MockKRWT + PolicyVault, vault에 1,000,000 mint)
npm run deploy -- --chain localhost --rpc http://127.0.0.1:8545

# 3. UI 시연 (로컬 체인·가짜 Kiln 고정) — http://127.0.0.1:3000
CHAIN=localhost KILN_MODE=fake RPC_URL=http://127.0.0.1:8545 DATABASE_PATH=data.local/app-ui-dev.sqlite npm run dev
```

E2E 8단계 데모와 증거 내보내기·검증을 한 번에 돌리려면(종료 코드 0 = 통과) 2번 다음에 `npm run e2e:local`을 실행한다. 전체 테스트는 `npm test`. 그 밖의 검증된 명령은 [docs/CodingRules.md](docs/CodingRules.md).

## Known limitations / 알려진 한계

- 소유자 지갑 서명이 필요한 단계(위임 확정·승인·정지)는 통합 테스트로만 검증했고, 실제 MetaMask 등 브라우저 확장에서의 서명 흐름은 자동 검증되지 않았다.
- 에너지 수치는 추정이지 측정값이 아니다(위 "Efficiency" 절).
- Base Sepolia 공개 RPC(`sepolia.base.org`)는 `eth_getLogs`를 1,000블록 범위로 제한해(-32614) 1,000블록 단위로 나눠 읽는다. 부하분산된 공개 RPC에서는 뒤처진 노드가 이벤트를 놓치거나 오래된 상태를 돌려줄 수 있다(추정, 이번 실제 실행에서는 나타나지 않음) — 전용 RPC를 쓰면 완화된다.
- 웹 접근성은 label·aria 연결만 확인했다 — 명도 대비와 키보드 포커스 순서는 측정하지 않았다.

## Documents / 문서

[PRD](docs/PRD.md) · [Architecture](docs/Architecture.md) · [DECISIONS](docs/DECISIONS.md) · [Tasks](docs/Tasks.md) · [CHANGELOG](docs/CHANGELOG.md)
