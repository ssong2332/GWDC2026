# ADR-0006: 최소 GitHub Actions CI — push·PR마다 `npm test` (D-21 "CI 미사용" 대체)

> 상태: 승인 (2026-09-29, 사용자 답 "승인 (Recommended)" — 메인 세션이 대신 반영. Node 22.14 고정: 사용자 답 "22.14 고정 (Recommended)")
> 날짜: 2026-09-29

## 맥락

D-21(2026-09-28)은 테스트 4계층 러너를 정하면서 "CI **미사용**"을 제안했고 사용자가 OQ #14에 "쓰지 않음"으로 답했다. 2026-09-29 사용자가 이를 바꿨다(메인 세션 전달, 인용):

- "GitHub Actions CI를 추가할까요? (기존 결정 D-21/OQ #14에서 사용자님이 'CI 쓰지 않음'으로 정했음)" = "최소 CI 추가" — 선택지 설명 원문: "npm test를 push마다 실행하는 워크플로 1개. 결정 변경이라 architect(새 ADR)·planner 경유"
- "CI를 언제 실행할까요?" = "push + PR (Recommended)"

D-21의 테스트 러너 부분(①~④)은 그대로 유지한다. 이 ADR은 D-21 중 "CI 미사용" 한 가지만 대체한다. PRD N-14(워크플로 1개, 시크릿 값 0개 — N-12)가 요구사항이다.

제약(이번 세션 확인):

| 제약 | 확인 근거 |
|---|---|
| 로컬 개발 환경은 Windows, Node 22.14 | 환경 정보 win32 / Architecture.md:17 "Node 22.14"(인용) |
| 패키지 2개, lockfile 2개(lockfileVersion 3) | `package-lock.json`, `chain/package-lock.json` 존재 |
| `npm --prefix chain install`은 `file:..` 순환을 만든다 → `npm --prefix chain ci` 사용 | docs/CodingRules.md:34~36 |
| 루트 설치의 검증된 명령은 `npm install`뿐(`npm ci`는 루트에서 미검증) | docs/CodingRules.md:33 |
| `npm test` = `test:contracts && test:unit && test:int` | package.json:17 |
| 통합 테스트는 `chain/`에서 `npx hardhat node --port 8546`을 스스로 띄운다(기동 대기 120s, 잠금 대기 300s) | tests/integration/setup/hardhat-node.ts:16~17, 88 |
| Vitest 5는 Node `^22.12.0 \|\| ^24 \|\| >=26` 요구, better-sqlite3 13은 `>=22` | node_modules/vitest/package.json:110, package-lock.json:1680 |

## 검토한 대안

### 러너 OS

| 대안 | 장점 | 단점 |
|---|---|---|
| A. `ubuntu-latest` | GitHub 호스티드 러너 중 가장 빠르고 흔하다. 로컬(Windows)과 다른 OS라 대소문자 구분 경로·POSIX 프로세스 종료 경로를 추가로 검증한다. lockfile에 linux-x64 바이너리 항목이 이미 있다(확인) | 로컬과 OS가 달라 "로컬 통과·CI 실패"가 생길 수 있다(대소문자 import, `process.kill(-pid)` 경로 — 아래 위험 표) |
| B. `windows-latest` | 로컬과 같은 OS — 차이로 인한 실패가 가장 적다 | 로컬이 이미 Windows라 새로 검증하는 것이 적다. 러너 기동·npm 설치가 느리다(추정). 비공개 repo면 분 소모 배수가 크다(추정 — 확인: GitHub 요금 문서) |
| C. 두 OS 매트릭스 | 양쪽 모두 검증 | "최소 CI"(사용자 선택) 범위를 넘는다. 실행 시간·실패 원인 분석 비용 2배 |

### 설치 명령

| 대안 | 장점 | 단점 |
|---|---|---|
| A. `npm ci` + `npm --prefix chain ci` | lockfile 그대로 설치, package.json·lockfile을 바꾸지 않는다. CI 표준 | 루트 `npm ci`는 로컬에서 검증된 적이 없다 — lockfile이 package.json과 어긋나 있으면 실패한다(그 자체가 유용한 신호) |
| B. `npm install` + `npm --prefix chain ci` | 루트 명령이 CodingRules에 검증됨 | CI가 lockfile을 조용히 갱신할 수 있어 재현성이 없다 |

### 트리거

| 대안 | 장점 | 단점 |
|---|---|---|
| A. `push`(전 브랜치) + `pull_request` | 사용자 답 "push + PR (Recommended)" 그대로. feature 브랜치 push마다, PR에서도 결과가 보인다 | 같은 repo 브랜치의 PR은 push·PR 두 번 실행된다(분 소모 2배 — 감수) |
| B. `push`만 | 실행 1회 | 사용자 답과 다르다 |

## 결정

- 러너 OS: **A. `ubuntu-latest`** — 로컬(Windows)이 이미 Windows 동작을 매번 확인하므로, CI는 다른 OS에서 한 번 더 확인하는 쪽이 얻는 것이 크다.
- 설치: **A. `npm ci` → `npm --prefix chain ci`**. `npm --prefix chain install`은 쓰지 않는다(CodingRules:35 순환 문제).
- 트리거: **A. `push`(브랜치 필터 없음) + `pull_request`(필터 없음)** — 사용자 답 그대로.
- 워크플로 명세는 docs/Architecture.md "테스트 전략 > CI" 표가 규격이다(D-37).

## 결과 (트레이드오프 포함)

- 얻는 것: push·PR마다 3계층(①②③) 테스트가 깨끗한 Linux 환경에서 돈다. 로컬 `.env`·로컬 `node_modules`·로컬 `data.local/`에 기대는 테스트가 있으면 드러난다.
- 감수하는 것: Linux 전용 실패를 고치는 시간(아래 위험 표), PR 브랜치의 중복 실행. 제출 증거 생성(④ E2E, 실제 Kiln·Base Sepolia)은 CI에서 돌리지 않는다 — 키가 필요하고(N-12 시크릿 0개 위반), 테스트가 아니라 증거 생성 절차다(Architecture.md 테스트 전략 ④ 행).
- 위험(확인/추정 구분)은 docs/Architecture.md "테스트 전략 > CI 위험" 표에 둔다 — 한 곳에만 둔다.
