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
| PolicyVault / Mock ERC20 컨트랙트 | planned (T-02) |
| 에이전트 코어: 사전 검사 정책 엔진 + Kiln 클라이언트 + 증거 저장 | planned (T-03) |
| E2E 데모 + 증거 JSON + 제3자 검증 스크립트 | planned (T-04) |
| UI ① 위임 + ② 대시보드 | planned (T-05) |
| UI ③ 감사 + ④ 효율 리포트 | planned (T-06) |

작업 단위·근거는 `docs/Tasks.md` 참조.

## Structure / 구조

단일 repo, 패키지 2개: 루트(Next.js 앱 + 에이전트 코어 + CLI) / `chain/`(Hardhat 전용). npm workspaces 미사용.

**현재 실제 구조 (T-01 완료 시점, 하네스만 존재):**

```
/                                  # 루트 패키지
├─ package.json  tsconfig.json  next.config.ts
├─ vitest.config.ts                # 계층 ② 단위 (tests/unit)
├─ vitest.integration.config.ts    # 계층 ③ 통합 (tests/integration)
├─ .env.example                    # 환경 변수 플레이스홀더
├─ src/app/                        # Next.js App Router 기본 골격 (layout.tsx, page.tsx)
├─ tests/unit/, tests/integration/ # 스모크 테스트 각 1개
├─ chain/                          # Hardhat 패키지 (별도 package.json), 컨트랙트는 아직 0개
│  └─ test/                        # 계층 ① 스모크 테스트 1개
└─ docs/, .agents/, .claude/       # 규칙·문서
```

**목표 구조 (`docs/Architecture.md` "구조 개요" 원문 — T-02~T-06에서 순차 추가, planned):**

```
├─ src/core/                       # 프레임워크 무의존 도메인·유스케이스 — planned (T-02, T-03)
├─ src/adapters/                   # kiln/, chain/, db/ — planned (T-02, T-03)
├─ src/config/, src/server/        # env 검증, 서버 합성 루트 — planned
├─ src/ui/                         # 지갑 연동 컴포넌트·훅 — planned (T-05, T-06)
├─ cli/                            # tsx 실행 스크립트 (키를 쓰는 유일한 프로세스) — planned (T-03, T-04)
├─ chain/contracts/                # PolicyVault.sol, MockKRWT.sol — planned (T-02)
├─ deployments/, evidence/         # 배포 주소·증거 JSON — planned (T-04)
└─ data.local/                     # SQLite·로컬 산출물 (.gitignore로 제외)
```

상세는 `docs/Architecture.md` "구조 개요", 작업별 범위는 `docs/Tasks.md` 참조.

## Required environment / 필요 환경

- Node.js 22 (확인됨: `node -v` → v22.14.0), npm
- `.env.example`을 `.env`로 복사한 뒤 값을 채운다 — **실제 값은 커밋 금지** (`.gitignore`가 `.env`류를 제외)
- 체인 작업(컨트랙트 컴파일·테스트)은 `chain/` 패키지의 별도 `npm install`이 필요

```bash
cp .env.example .env
```

## Run / Build / Test — 검증된 명령어

아래는 `docs/CodingRules.md` "검증된 명령어" 절의 원문이다 (변형 없이 그대로 사용).

| 용도 | 명령 (원문) | 검증일 |
|---|---|---|
| 설치 (루트 — Next 앱·코어·Vitest) | `npm install` | 2026-09-28 |
| 설치 (chain — Hardhat) | `npm --prefix chain install` | 2026-09-28 |
| 빌드 (Next.js) | `npm run build` | 2026-09-28 |
| 빌드 (컨트랙트 컴파일) | `npm run chain:compile` | 2026-09-28 |
| 실행 (개발 서버, 127.0.0.1:3000) | `npm run dev` | 2026-09-28 |
| 테스트 (전체: contracts → unit → int) | `npm test` | 2026-09-28 |
| 테스트 ① 컨트랙트 (Hardhat) | `npm run test:contracts` | 2026-09-28 |
| 테스트 ② 단위 (Vitest) | `npm run test:unit` | 2026-09-28 |
| 테스트 ③ 통합 (Vitest) | `npm run test:int` | 2026-09-28 |

## Known issue / 알려진 이슈

컨트랙트가 아직 0개인 현재(T-02 착수 전) `npm run chain:compile`·`npm run test:contracts` 실행 시 "Error writing artifacts definition: ENOENT … chain\build\artifacts\artifacts.d.ts"가 출력되지만 종료 코드는 0이고 테스트는 통과한다(reviewer·quality-assurance 확인, T-01 리뷰 권고 사항). T-02에서 컨트랙트 추가 후 재확인 예정.

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
