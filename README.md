# Agent Spending Control & Evidence Layer (working title)

> 프로젝트 이름 미정 (PRD Open Question #2, `docs/PRD.md`). 이 리포는 [start_coding](https://github.com/) 템플릿에서 초기화되어 현재 GWDC 2026 KOREA 해커톤 챌린지 B 출품작으로 진행 중이다.
> This repo was bootstrapped from the [start_coding](https://github.com/) template and is now under active development as an entry for the GWDC 2026 KOREA hackathon, Challenge B.

## One-line definition (working draft) / 한 줄 정의 (초안)

> 기능이 아직 완성되지 않아 확정 문구가 아니다 — 최종 문구는 해커톤 제출 전 확정한다 (PRD "한 줄 정의" 원문 기반).
> Not final — the hackathon submission's one-sentence declared function will be confirmed once the feature set is complete. Draft below is copied from `docs/PRD.md` "한 줄 정의".

**EN:** When an AI agent spends event/club budget on a user's behalf, spending limits are enforced by code and the on-chain `PolicyVault` — never by the AI — and every payment, block, approval, and pause is recorded so a third party can reconstruct it from the record alone.

**KR:** AI 에이전트가 동아리·학생회 행사비를 대신 쓸 때, 한도 판정은 AI가 아니라 코드와 온체인 `PolicyVault`가 하고, 모든 결제·차단·승인·중지를 제3자가 기록만으로 재구성할 수 있게 남기는 지출 통제·증거 계층.

## Users / 사용자

| Type / 유형 | Need / 니즈 |
|---|---|
| Budget owner (club president) / 돈을 맡기는 사람 (동아리 회장) | 자연어 위임 → 정책 확인 → 지갑 서명, 지출 추적, 승인, 중지, 영수증 |
| Auditor (third party) / 검사하는 사람 (감사·회원) | 소유자·운영자에게 묻지 않고 공개 기록(증거 JSON + 온체인 이벤트)만으로 각 결제가 허용 범위 안이었는지 재구성 |
| Spending agent (software) / 지출 에이전트 | 정책 안에서만 결제를 실행, 막히면 사유가 기록됨, 규칙을 스스로 바꿀 수 없음 |

상세는 `docs/PRD.md` "사용자" 절 참조.

## Status / 구현 상태

| 영역 | 상태 |
|---|---|
| 테스트 하네스 (Next.js 골격, Hardhat, Vitest 단위/통합, 스모크 테스트) | 완료 (T-01) |
| PolicyVault / Mock ERC20 컨트랙트 | 완료 (T-02) |
| 에이전트 코어: 사전 검사 정책 엔진 + Kiln 클라이언트 + 증거 저장 | 완료 (T-03) |
| E2E 데모 + 증거 JSON + 제3자 검증 스크립트 | 완료 (T-04) — **Base Sepolia 실행은 아직 안 함**(사용자 준비물 대기: 테스트넷 지갑·faucet ETH·`.env.cli` 개인키·Kiln 팀 키). 로컬 체인 E2E는 통과 |
| UI ① 위임 + ② 대시보드 | 완료 (T-05) — 지갑 서명 경로는 통합 테스트로만 검증, 실제 MetaMask 등 브라우저 확장 미검증 |
| UI ③ 감사 + ④ 효율 리포트 | planned (T-06) |

작업 단위·근거는 `docs/Tasks.md` 참조.

## Structure / 구조

단일 repo, 패키지 2개: 루트(Next.js 앱 + 에이전트 코어 + CLI) / `chain/`(Hardhat 전용). npm workspaces 미사용.

**현재 실제 구조 (T-01~T-05 완료 시점):**

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
│  └─ _env.ts, _container.ts       # CLI 전용 env 로드·의존성 조립
├─ src/
│  ├─ app/                         # Next.js App Router: layout.tsx, page.tsx, dashboard/, delegate/, globals.css
│  │  └─ api/                      # Route Handler 6개 (policy/parse, owner-actions/{prepare,confirm}, vault/{activity,state}, receipts/[requestId])
│  ├─ core/                        # 프레임워크 무의존 도메인·유스케이스 (domain/, usecases/, ports.ts, errors.ts)
│  ├─ adapters/                    # kiln/ (실제+가짜 클라이언트), chain/ (viemVault.ts, networks.ts, generated/ ABI·bytecode), db/ (SQLite 증거·이벤트 캐시 저장)
│  ├─ server/                      # Route Handler용 env 로드·의존성 조립 (server-only, 개인키 있으면 시작 거부 — D-16)
│  ├─ config/                      # constants.ts, merchants.ts, env.ts(서버·CLI 공용 zod 스키마, ADR-0005)
│  └─ ui/                          # 위임(delegate/)·대시보드(dashboard/)·지갑 연결·서명(wallet/)·재사용 컴포넌트(components/)·훅(hooks/)
├─ tests/
│  ├─ unit/                        # 계층 ②
│  ├─ integration/                 # 계층 ③ + setup/hardhat-node.ts
│  └─ fixtures/rule-cases.json     # 컨트랙트·precheck 공용 판정 케이스
├─ chain/                          # Hardhat 패키지 (별도 package.json)
│  ├─ contracts/                   # PolicyVault.sol, MockKRWT.sol
│  ├─ scripts/                     # export-artifacts.ts
│  └─ test/                        # 계층 ① — PolicyVault·MockKRWT·ruleCases·scripts 테스트
├─ data.local/                     # 로컬 산출물 (배포 주소·SQLite·E2E 증거, .gitignore로 제외)
└─ docs/, .agents/, .claude/       # 규칙·문서
```

`evidence/`(Base Sepolia 증거 JSON, 커밋 대상 — `docs/Architecture.md` "구조 개요")는 Base Sepolia 실행 전이라 아직 리포에 없다.

UI ③감사·④효율 리포트(T-06)는 아직 없다 — `docs/Tasks.md` 참조.

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

## Base Sepolia 실행 절차 (사용자용)

Base Sepolia 실행은 아직 하지 않았다(사용자 준비물 대기). 준비되면:

1. `.env`에: `CHAIN=baseSepolia`, `RPC_URL=https://sepolia.base.org`, `KILN_MODE=real`, `KILN_API_KEY=<발급받은 키>`, `OWNER_ADDRESS=<소유자 지갑 주소>`, `FEE_RECIPIENT_ADDRESS=<수수료 수령 주소>`.
2. **개인키 2개(`AGENT_PRIVATE_KEY`, `OWNER_PRIVATE_KEY`)는 `.env`가 아니라 `.env.cli`에만 넣는다** — Next.js는 `.env`를 서버 프로세스에 자동 로드하므로, 키가 `.env`에 있으면 웹 서버(`src/server/env.ts`, D-16)가 시작을 거부한다.
3. 실행: `npm run e2e:sepolia -- --deploy`
4. 재내보내기·검증(위 표 원문, `--chain` 값만 `baseSepolia`로): `npm run evidence:export -- --chain baseSepolia --db <e2e:sepolia가 쓴 DB 경로>`, `npm run evidence:verify -- --file <내보낸 evidence.json> --rpc https://sepolia.base.org`.

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
