# Agent Spending Control & Evidence Layer (working title)

> 프로젝트 이름 미정 (PRD Open Question #2, `docs/PRD.md`). 이 리포는 [start_coding](https://github.com/) 템플릿에서 초기화되어 현재 GWDC 2026 KOREA 해커톤 챌린지 B 출품작으로 진행 중이다.
> This repo was bootstrapped from the [start_coding](https://github.com/) template and is now under active development as an entry for the GWDC 2026 KOREA hackathon, Challenge B.

## Declared function (one sentence) / 선언한 기능 (한 문장)

> GWDC 2026 챌린지 B 요구사항: "Declare in one sentence, in your README, the function you built." (FuriosaAI × Bricksum Challenge B brief). 아래 한 문장을 기준으로 심사한다 — `docs/PRD.md` "한 줄 정의" 원문 그대로.

**EN:** When an AI agent spends event/club budget on a user's behalf, spending limits are enforced by code and the on-chain `PolicyVault` — never by the AI — and every payment, block, approval, and pause is recorded so a third party can reconstruct it from the record alone.

**KR:** AI 에이전트가 동아리·학생회 행사비를 대신 쓸 때, 한도 판정은 AI가 아니라 코드와 온체인 `PolicyVault`가 하고, 모든 결제·차단·승인·중지를 제3자가 기록만으로 재구성할 수 있게 남기는 지출 통제·증거 계층.

## Who / problem / what the AI does vs. what the code enforces / 사용자·문제·AI와 코드의 경계

| 구분 | 내용 |
|---|---|
| Who / 사용자 | 예산을 맡기는 사람(동아리 회장 — 소유자 지갑)과 검사하는 사람(감사·회원 — 제3자). 상세는 아래 "Users / 사용자" 표, 근거는 `docs/PRD.md` "사용자" 절 |
| Problem / 문제 | 동아리·학생회 행사비를 AI 에이전트가 대신 지출할 때, 얼마까지·어디에 쓸 수 있는지를 AI 판단에 맡기면 위험하다 — 한도는 AI가 아니라 코드가 정해야 제3자가 신뢰할 수 있다 (`docs/PRD.md` "배경/문제") |
| AI가 하는 일 (Kiln `qwen3-32b`) | ① 위임 문장(자연어) → 정책 후보(총예산·허용 가맹점·건당 승인 임계·기한) 변환 (F-01). ② 개별 구매가 위임 목적에 맞는지 판단만 한다(F-07) — 예산·한도·가맹점 여부는 판단하지 않는다 |
| 코드·컨트랙트가 강제하는 일 | 총예산, 허용 가맹점, 건당 승인 임계, 기한, 수수료 포함 예산, 호출 폭주 한도(분당·일일), 정지(pause) — 전부 온체인 `PolicyVault.spend()`의 판정 순서(아래 "Boundary & where enforced")로 고정된다 |
| AI는 경계를 넓힐 수 없다 | Kiln이 "위임 목적에 맞지 않음"(mismatch)·판단 실패(invalid_output·error)로 답해도 결과는 **승인 대기로만 엄격화**된다(D-10 fail-closed) — Kiln이 코드가 이미 막은 요청을 통과시키는 경로는 없다 |

## Users / 사용자

| Type / 유형 | Need / 니즈 |
|---|---|
| Budget owner (club president) / 돈을 맡기는 사람 (동아리 회장) | 자연어 위임 → 정책 확인 → 지갑 서명, 지출 추적, 승인, 중지, 영수증 |
| Auditor (third party) / 검사하는 사람 (감사·회원) | 소유자·운영자에게 묻지 않고 공개 기록(증거 JSON + 온체인 이벤트)만으로 각 결제가 허용 범위 안이었는지 재구성 |
| Spending agent (software) / 지출 에이전트 | 정책 안에서만 결제를 실행, 막히면 사유가 기록됨, 규칙을 스스로 바꿀 수 없음 |

상세는 `docs/PRD.md` "사용자" 절 참조.

## Boundary & where enforced / 경계와 강제 지점

`chain/contracts/PolicyVault.sol`의 `spend()`가 매 요청마다 아래 순서로 판정한다(TS `evaluatePrecheck`가 같은 순서를 미러 — 패리티 테스트 대상, `docs/Architecture.md` 1절 "spend 판정 순서"). 차단(1~8)이 대기(9)보다 우선한다.

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

차단·대기는 revert가 아니라 이벤트(`SpendBlocked(reason)`/`SpendPending(flags)`)로 기록되고 tx는 성공(mined)한다 — 사전 검사(코드)가 막은 요청도 같은 인자로 PolicyVault에 제출해 온체인에 남긴다(F-06).

## Status / 구현 상태

| 영역 | 상태 |
|---|---|
| 테스트 하네스 (Next.js 골격, Hardhat, Vitest 단위/통합, 스모크 테스트) | 완료 (T-01) |
| PolicyVault / Mock ERC20 컨트랙트 | 완료 (T-02) |
| 에이전트 코어: 사전 검사 정책 엔진 + Kiln 클라이언트 + 증거 저장 | 완료 (T-03) |
| E2E 데모 + 증거 JSON + 제3자 검증 스크립트 | 완료 (T-04) — Base Sepolia 실행 완료(아래 "Base Sepolia evidence" 참조, 2026-09-28T14:44Z, 실제 Kiln 8회) |
| UI ① 위임 + ② 대시보드 | 완료 (T-05) — 지갑 서명 경로는 통합 테스트로만 검증, 실제 MetaMask 등 브라우저 확장 미검증 |
| UI ③ 감사 + ④ 효율 리포트 | 완료 (T-06), 공개 RPC 읽기 재시도 (T-07) |

작업 단위·근거는 `docs/Tasks.md` 참조.

## Structure / 구조

단일 repo, 패키지 2개: 루트(Next.js 앱 + 에이전트 코어 + CLI) / `chain/`(Hardhat 전용). npm workspaces 미사용.

**현재 실제 구조 (T-01~T-07 완료 시점):**

```
/                                  # 루트 패키지
├─ package.json  tsconfig.json  next.config.ts
├─ vitest.config.ts                # 계층 ② 단위 (tests/unit)
├─ vitest.integration.config.ts    # 계층 ③ 통합 (tests/integration), Hardhat 노드(포트 8546) 자동 기동
├─ .env.example                    # 환경 변수 플레이스홀더 (개인키 자리는 .env가 아니라 .env.cli용, ADR-0005)
├─ cli/                            # tsx 실행 스크립트 (개인키를 쓰는 유일한 프로세스)
│  ├─ deploy.ts                    # 배포 통합 (--chain localhost|baseSepolia), T-02의 chain:deploy:local 대체 (D-30)
│  ├─ e2e.ts                       # E2E 데모 (로컬·Base Sepolia 공통, 8단계, F-15)
│  ├─ export-evidence.ts, verify-evidence.ts   # 증거 JSON 내보내기 · 제3자 검증 (F-12)
│  ├─ report-efficiency.ts         # 흐름별 토큰·cost·에너지 상한 Markdown 표 (F-14, T-06)
│  └─ _env.ts, _container.ts       # CLI 전용 env 로드·의존성 조립
├─ src/
│  ├─ app/                         # Next.js App Router: layout.tsx, page.tsx, dashboard/, delegate/, audit/, efficiency/, globals.css
│  │  └─ api/                      # Route Handler 8개 (policy/parse, owner-actions/{prepare,confirm}, vault/{activity,state}, receipts/[requestId], audit/[txHash], efficiency)
│  ├─ core/                        # 프레임워크 무의존 도메인·유스케이스 (domain/, usecases/, ports.ts, errors.ts)
│  ├─ adapters/                    # kiln/ (실제+가짜 클라이언트), chain/ (viemVault.ts, networks.ts, readRetry.ts, generated/ ABI·bytecode), db/ (SQLite 증거·이벤트 캐시 저장)
│  ├─ server/                      # Route Handler용 env 로드·의존성 조립 (server-only, 개인키 있으면 시작 거부 — D-16)
│  ├─ config/                      # constants.ts, merchants.ts, env.ts(서버·CLI 공용 zod 스키마, ADR-0005)
│  └─ ui/                          # 위임(delegate/)·대시보드(dashboard/)·감사(audit/)·효율(efficiency/)·지갑 연결·서명(wallet/)·재사용 컴포넌트(components/)·훅(hooks/)
├─ tests/
│  ├─ unit/                        # 계층 ②
│  ├─ integration/                 # 계층 ③ + setup/hardhat-node.ts
│  └─ fixtures/rule-cases.json     # 컨트랙트·precheck 공용 판정 케이스
├─ chain/                          # Hardhat 패키지 (별도 package.json)
│  ├─ contracts/                   # PolicyVault.sol, MockKRWT.sol
│  ├─ scripts/                     # export-artifacts.ts
│  └─ test/                        # 계층 ① — PolicyVault·MockKRWT·ruleCases·scripts 테스트
├─ deployments/baseSepolia.json    # Base Sepolia 배포 주소·deployBlock (커밋)
├─ evidence/base-sepolia/          # 제출용 증거 JSON (커밋 — evidence.json, run-*.json, "Base Sepolia evidence" 절 참조)
├─ data.local/                     # 로컬 산출물 (배포 주소·SQLite·E2E 증거, .gitignore로 제외)
└─ docs/, .agents/, .claude/       # 규칙·문서
```

상세는 `docs/Architecture.md` "구조 개요", 작업별 범위는 `docs/Tasks.md` 참조.

## Required environment / 필요 환경

- Node.js 22 (확인됨: `node -v` → v22.14.0), npm
- `.env.example`을 `.env`로 복사한 뒤 값을 채운다 — **실제 값은 커밋 금지** (`.gitignore`가 `.env`류를 제외)
- 체인 작업(컨트랙트 컴파일·테스트)은 `chain/` 패키지의 별도 설치가 필요 — 아래 표의 `npm --prefix chain ci`

```bash
cp .env.example .env
```

## Run / Build / Test — 검증된 명령어

아래는 `docs/CodingRules.md` "검증된 명령어" 절의 원문이다 (변형 없이 그대로 사용).

| 용도 | 명령 (원문) | 검증일 |
|---|---|---|
| 설치 (루트 — Next 앱·코어·Vitest) | `npm install` | 2026-09-28 |
| 설치 (chain — lockfile 기준, 루트에서) | `npm --prefix chain ci` | 2026-09-28 |
| chain 의존성 lock 갱신 (chain 디렉터리에서 — `--prefix` 쓰지 말 것) | `cd chain && npm install` (Git Bash) | 2026-09-28 |
| 빌드 (Next.js) | `npm run build` | 2026-09-28 |
| 빌드 (컨트랙트 컴파일) | `npm run chain:compile` | 2026-09-28 |
| 실행 (개발 서버, 127.0.0.1:3000) | `npm run dev` | 2026-09-28 |
| 테스트 (전체: contracts → unit → int) | `npm test` | 2026-09-28 |
| 테스트 ① 컨트랙트 (Hardhat) | `npm run test:contracts` | 2026-09-28 |
| 테스트 ② 단위 (Vitest) | `npm run test:unit` | 2026-09-28 |
| 테스트 ③ 통합 (Vitest) | `npm run test:int` | 2026-09-28 |
| ABI·bytecode export (chain/build/artifacts → src/adapters/chain/generated/; `chain:compile`이 컴파일 뒤 자동 호출) | `npm run chain:export` | 2026-09-28 |
| 로컬 체인 노드 실행 (127.0.0.1:8545, 별도 터미널 — 종료 전까지 점유) | `npm run chain:node` | 2026-09-28 |
| 로컬 배포 (실행 중인 chain:node에 MockKRWT+PolicyVault 배포, vault에 1,000,000 mint → data.local/deployments/localhost.json) | `npm run deploy -- --chain localhost --rpc http://127.0.0.1:8545` | 2026-09-28 |
| 테스트 ④ E2E 로컬 (chain:node 실행 중 — 배포·8단계·증거 내보내기·검증까지, 종료 코드 0 = 통과) | `npm run e2e:local` | 2026-09-28 |
| 증거 JSON 내보내기 (로컬 E2E DB → data.local/evidence/localhost/evidence.json) | `npm run evidence:export -- --chain localhost --db data.local/e2e-localhost.sqlite` | 2026-09-28 |
| 제3자 검증 (로컬 — mismatches 0이면 종료 코드 0) | `npm run evidence:verify -- --file data.local/evidence/localhost/evidence.json --rpc http://127.0.0.1:8545` | 2026-09-28 |
| 테스트 ① + 가스 표 (hardhat-gas-reporter, toolbox 내장) | `REPORT_GAS=true npm run test:contracts` (Git Bash) | 2026-09-28 |
| 타입 검사 (루트 — src·tests 전체, 산출물 없음) | `npx tsc --noEmit -p tsconfig.json` | 2026-09-28 |
| 테스트 ③ 단일 파일 (Hardhat 노드 자동 기동 포함) | `npx vitest run --config vitest.integration.config.ts tests/integration/db.test.ts` | 2026-09-28 |
| 실행 (개발 서버를 로컬 체인·가짜 Kiln으로 강제 — 사용자 env 파일이 CHAIN=baseSepolia여도 프로세스 환경 변수가 우선. chain:node 실행 + 로컬 배포 후, Git Bash) | `CHAIN=localhost KILN_MODE=fake RPC_URL=http://127.0.0.1:8545 DATABASE_PATH=data.local/app-ui-dev.sqlite npm run dev` | 2026-09-28 |
| 효율 리포트 표 (내보낸 증거 JSON → 흐름별 토큰·cost·에너지 상한 Markdown 표, .env·DB·RPC 불필요) | `npm run report:efficiency -- --file evidence/base-sepolia/evidence.json` | 2026-09-29 |
| 제3자 검증 (Base Sepolia 공개 RPC 기본값, 읽기 전용 — mismatches 0이면 종료 코드 0) | `npm run evidence:verify -- --file evidence/base-sepolia/evidence.json` | 2026-09-29 |

통합 테스트(계층 ③)는 포트 8546의 Hardhat 노드 하나를 공유하고, 동시에 여러 번 실행하면 잠금 파일로 직렬화되어 한 번에 하나씩만 돈다(`tests/integration/setup/hardhat-node.ts`).

`npm --prefix chain install`(옛 행)은 실행할 때마다 `chain/package.json`에 `"gwdc2026": "file:.."`를 재추가해 순환 링크를 만드는 문제가 있어 위 두 행(`npm --prefix chain ci` / `cd chain && npm install`)으로 교체됐다(`docs/CodingRules.md` 참조). `npm run chain:deploy:local`(옛 행)도 배포 경로가 `cli/deploy.ts` 하나로 통합되며(D-30) 위 `npm run deploy -- --chain localhost ...` 행으로 교체됐다.

## Local demo / 로컬 데모 방법

별도 터미널 3개(또는 순차)로 다음을 실행한다 (모두 위 표의 원문):

```bash
# 1. 로컬 체인 노드 (별도 터미널, 종료 전까지 점유)
npm run chain:node

# 2. 배포 (MockKRWT + PolicyVault, vault에 1,000,000 mint)
npm run deploy -- --chain localhost --rpc http://127.0.0.1:8545

# 3. E2E 8단계 데모 + 증거 내보내기·검증까지 한 번에 (종료 코드 0 = 통과)
npm run e2e:local

# 4. UI 시연 (로컬 체인·가짜 Kiln 고정, 3번과 별도 DB)
CHAIN=localhost KILN_MODE=fake RPC_URL=http://127.0.0.1:8545 DATABASE_PATH=data.local/app-ui-dev.sqlite npm run dev
```

## Submission evidence policy / 제출 증거 운영 규칙

> 사용자 결정 원문(선택지 "운영 규칙으로 (추천)"): "제출용 증거는 CLI(e2e:sepolia --deploy)가 새 vault와 전용 DB로 만든 것만 내보냅니다. UI 시연은 별도 DB를 씁니다. 코드 수정이 없어 사용량이 들지 않고, 규칙은 docs가 README에 적습니다."

즉 해커톤 제출용 증거 JSON은 `npm run e2e:sepolia -- --deploy`가 만든 DB에서만 `evidence:export`로 내보낸다. UI를 켜서 시연할 때는 위 로컬 데모 4번처럼 `DATABASE_PATH`를 별도로 지정해 같은 DB를 공유하지 않는다. 이유: UI에서 소유자가 지갑 서명을 거절하면 anchor 없는(tx가 없는) owner 증거가 DB에 남고, 그 DB로 내보낸 증거를 검증하면 `TX_NOT_FOUND` 불일치로 세어진다 — 이는 결함이 아니라 설계대로의 동작이다(D-23, `docs/Architecture.md` 배포 절 "운영 규칙").

## Base Sepolia 실행 절차 (사용자용, 재현 방법)

Base Sepolia 실행은 2026-09-28T14:44Z에 1회 완료했다(아래 "Base Sepolia evidence" 절 참조). 재현하려면:

1. `.env`에: `CHAIN=baseSepolia`, `RPC_URL=https://sepolia.base.org`, `KILN_MODE=real`, `KILN_API_KEY=<발급받은 키>`, `OWNER_ADDRESS=<소유자 지갑 주소>`, `FEE_RECIPIENT_ADDRESS=<수수료 수령 주소>`.
2. **개인키 2개(`AGENT_PRIVATE_KEY`, `OWNER_PRIVATE_KEY`)는 `.env`가 아니라 `.env.cli`에만 넣는다** — Next.js는 `.env`를 서버 프로세스에 자동 로드하므로, 키가 `.env`에 있으면 웹 서버(`src/server/env.ts`, D-16)가 시작을 거부한다.
3. 실행: `npm run e2e:sepolia -- --deploy`
4. 재내보내기·검증(위 표 원문, `--chain` 값만 `baseSepolia`로): `npm run evidence:export -- --chain baseSepolia --db <e2e:sepolia가 쓴 DB 경로>`, `npm run evidence:verify -- --file <내보낸 evidence.json> --rpc https://sepolia.base.org`.

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

전체 17단계(배포 3건 포함)는 run JSON 원문 참조. `run-2026-09-28T14-44-28-469Z.json`의 `"mismatches": 0` — 내보낸 증거 JSON을 그 실행 시점에 재해시해 온체인 이벤트와 대조한 결과다(아래 "Verify it yourself"에서 메인 세션이 직접 재확인한 결과와 별개로 실행 로그 자체에 기록된 값).

## Efficiency (per flow) / 흐름별 효율

`npm run report:efficiency -- --file evidence/base-sepolia/evidence.json` 실행 원문(메인 세션 직접 실행, 2026-09-29):

```
provider: kiln

| flow | Kiln calls | requests | prompt | completion | reasoning | total tokens | cost (USD) | energy upper bound (Wh) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| policy_parse | 1 | 1 | 624 | 451 | 367 | 1075 | 0.00017604 | 0.8086 |
| intent_judge | 7 | 7 | 2416 | 1794 | 1497 | 4210 | 0.00062924 | 3.4241 |
| rule_block | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0.0000 |
| total | 8 | - | 3040 | 2245 | 1864 | 5285 | 0.00080528 | 4.2327 |

Rule-blocked requests: 3 (0 Kiln calls). Avoided (estimate from the intent_judge average): ~1804 tokens, ~1.4675 Wh.
Energy: E_Wh = latency_s × cards × P_card_W ÷ 3600 (upper bound: the whole card power is attributed to this request, batching ignored)
  - cards = 2 cards — qwen3-32b BF16 weights ≈ 64 GB > 48 GB HBM of one FuriosaAI RNGD card → at least 2 cards (assumed; Kiln's serving setup is not published)
  - cardPowerW = 180 W — FuriosaAI RNGD published TDP 180 W (assumed full draw for the whole request)
Estimate (assumed), not measured. Latency is measured by this client; power and card count are assumptions.
```

- **에너지는 상한(upper bound)이며 측정값이 아니다** — 가정: FuriosaAI RNGD 카드 2장 × 180W(위 원문 근거), `docs/DECISIONS.md` D-20.
- **불필요한 추론 절감**: 규칙으로 막힌 3건(`rule_block`)은 Kiln을 0회 호출했다 — `intent_judge` 흐름의 평균으로 추정하면 약 1,804 토큰·1.4675 Wh를 아꼈다(추정, 위 원문 "Avoided" 줄).

## Verify it yourself (third party) / 제3자 직접 검증

키·DB·운영자 없이 공개 RPC만으로 검증할 수 있다:

```bash
npm install
npm run evidence:verify -- --file evidence/base-sepolia/evidence.json
```

메인 세션이 2026-09-29에 직접 실행해 확인(원문): `mismatches: 0`, 레코드 14건·온체인 이벤트 15건 전부 `OK`(각 항목의 재계산 해시 = 온체인 해시). `evidence/base-sepolia/evidence.json`을 변조한 사본으로 실행하면 해당 항목이 불일치로 보고된다(F-12 ②, `tests/integration/evidenceExport.test.ts`로 자동 검증됨).

감사 화면(`/audit?tx=<hash>`)은 같은 재계산·대조를 tx hash 1건 단위로 브라우저에서 보여준다 — 정책·요청·AI 판단·차단 사유·승인자를 재구성하고 "해시 일치" 여부를 표시한다.

## Human side / 사람이 보는 화면 4개

| 화면 | 경로 | 내용 |
|---|---|---|
| ① 위임 | `/delegate` | 자연어 위임 문장 입력 → Kiln이 만든 정책 후보 확인·수정 → 소유자 브라우저 지갑 서명 |
| ② 대시보드 | `/dashboard` | 잔여 예산·지출 목록, 승인 대기함(승인/거절 서명), 정지(pause) 버튼, 영수증 |
| ③ 감사 | `/audit` | tx hash 입력 → 증거 재구성 + 해시 일치 표시 (제3자가 소유자·운영자 없이 검증) |
| ④ 효율 | `/efficiency` | 흐름별 토큰 4종·cost·호출 수·Generation-Id, 규칙 차단 절감, 에너지 상한 추정 |

## Known limitations / 알려진 한계

- 지갑 서명 UI는 통합 테스트(`tests/integration/walletOwnerAction.test.ts` 등)로만 검증했다 — 실제 MetaMask 등 브라우저 확장에서의 서명 흐름은 자동 검증되지 않았다(T-05 구현 근거, 인용).
- 효율 리포트의 에너지 수치는 추정(assumed)이지 측정값이 아니다 — 위 "Efficiency" 절의 가정·출처 참조.
- Base Sepolia 공개 RPC(`sepolia.base.org`)는 `eth_getLogs`를 1,000블록 범위로 제한한다(-32614) — `src/config/constants.ts`의 `LOG_BLOCK_CHUNK = 1_000n`으로 청크를 나눠 대응했다(T-07).
- Qwen3 thinking 모드를 끄는 방법의 효과는 검증하지 못했다(추정). `KILN_THINKING_MODE` 플래그(`default` | `kwargs_off` | `no_think`)는 있지만 Base Sepolia 실행은 `default`로 동작했고, `npm run report:efficiency` 출력 total 행에 reasoning 토큰 1,864가 포함돼 있다(`.env.example` 22-23행 주석, PRD Open Question #3). 확인 방법: 같은 요청을 켜고/끄고 보내 reasoning 토큰 수를 비교한다.
- 웹 접근성은 label·aria 연결만 리뷰에서 확인했다 — 명도 대비와 키보드 포커스 순서는 수치로 측정하지 않았다(QA 미검증 항목).
- 공개 RPC 잔여 위험(추정, 이번 실제 실행에서는 나타나지 않음): 부하분산된 공개 RPC의 뒤처진 노드가 ① `getLogs` 범위를 조용히 잘라 이벤트를 놓치거나 ② 연속 tx에서 nonce를 늦게 읽어 "nonce too low"를 내거나 ③ `readContract`(`getState`·`getPending`)가 오래된 상태를 돌려줄 수 있다. 전용 RPC를 쓰면 완화된다(T-07 implementer 보고, reviewer 권고 — 인용).
- Next.js 16의 `next dev`/`next build`가 루트 `AGENTS.md`를 자동으로 덧붙이는 문제가 있다 — 아래 "Known issue" 절 참조.

## Known issue / 알려진 이슈

- T-01 시점에 있었던 "Error writing artifacts definition: ENOENT … chain\build\artifacts\artifacts.d.ts" 로그는 T-02에서 컨트랙트(`chain/contracts/PolicyVault.sol`, `MockKRWT.sol`)가 추가된 뒤 사라졌다(implementer·quality-assurance 확인, T-02 구현 근거).
- Next.js 16의 `next dev`/`next build`가 루트 `AGENTS.md` 끝에 `<!-- BEGIN:nextjs-agent-rules -->` 블록을 자동으로 덧붙인다. `AGENTS.md`는 사용자 소유·규칙 원본이므로 **이 블록을 커밋하지 않는다** — `npm run dev`/`npm run build` 실행 후 `git status`에 `AGENTS.md` 변경이 보이면 되돌린다(`docs/KitFeedback.md` #8).

## Development pipeline / 개발 파이프라인

아이디어 인터뷰 → 기획 → 설계 → 구현 → 리뷰/검증 → 문서화. 단계별 산출물과 게이트는 [AGENTS.md](AGENTS.md) 참조.

인터뷰는 아이디어를 받아 적는 단계가 아니라 **같이 설계하는 대화**다: 개인/팀·언어·배포·기능 범위 등 빈칸을 질문으로 채우고, 선택지마다 추천 방향과 반대 방향을 함께 제시하며, 사용자가 "완성"을 선언할 때까지 계속된다. 절차는 [.agents/skills/idea-interview/SKILL.md](.agents/skills/idea-interview/SKILL.md).

## Rule enforcement tools / 규칙 도구 (Claude Code · Codex · 안티그래비티)

Claude Code / Codex / 안티그래비티 어느 도구로 열어도 같은 규칙(AGENTS.md)이 적용된다.

| 도구 | 규칙 읽는 방식 | 강제 계층 활성 조건 |
|---|---|---|
| Claude Code | CLAUDE.md의 `@AGENTS.md` import | 자동 |
| Codex | 루트 AGENTS.md 직접 읽음 | **최초 1회 `/hooks` 신뢰 승인 필요 — 안 하면 무동작** |
| 안티그래비티 (Gemini) | 루트 AGENTS.md 직접 읽음 | cwd=워크스페이스 루트 전제 — `.env` 차단 1회 확인 필수 |

## Reporting kit issues / 이 킷 자체의 문제를 발견하면

규칙 때문에 막히거나 우회했다면 **여기서 규칙을 고치지 말고** [docs/KitFeedback.md](docs/KitFeedback.md)에 행을 추가한다. 나중에 템플릿 리포에서 그 표를 읽고 원본을 고치면 다음 프로젝트부터 반영된다.

## Documents / 문서 지도

| 문서 | 내용 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 요구사항, 사용자, Open Questions |
| [docs/Architecture.md](docs/Architecture.md) | 구조, 계층, 배포 |
| [docs/DECISIONS.md](docs/DECISIONS.md), [docs/adr/](docs/adr/) | 설계 결정·ADR |
| [docs/Tasks.md](docs/Tasks.md) | 작업 목록·상태 |
| [docs/CodingRules.md](docs/CodingRules.md) | 검증된 명령어, 코딩 규칙 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 변경 이력 |
| [docs/DefinitionOfDone.md](docs/DefinitionOfDone.md), [docs/GitWorkflow.md](docs/GitWorkflow.md) | 완료 기준, Git 워크플로 |
