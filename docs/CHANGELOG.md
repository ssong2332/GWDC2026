# CHANGELOG — Agent Spending Control & Evidence Layer (가칭)

> 소유자: docs | 형식: [Keep a Changelog](https://keepachangelog.com/ko/) 축약. 최신이 위.

## [Unreleased]

### Added
- 2026-09-28 T-03 에이전트 코어 (완료): 사전 검사 정책 엔진(`src/core/domain/precheck.ts` 등 `src/core/domain/*`), Kiln 클라이언트 실제(`src/adapters/kiln/openaiKilnClient.ts`)·가짜(`fakeKilnClient.ts`) 구현, SQLite 증거 저장(`src/adapters/db/{sqlite,evidenceRepo,kilnCallRepo,spendRequestRepo}.ts`), 유스케이스 `parsePolicy`·`processSpendRequest`(`src/core/usecases/`), 단위 테스트 84개(`tests/unit/*.test.ts`) + 통합 테스트 40개(`tests/integration/{db,parsePolicy,processSpendRequest}.test.ts`, 가짜 Kiln 응답 + 실제 Hardhat 노드 + SQLite)
- 2026-09-28 T-02 PolicyVault + MockKRWT 컨트랙트 (완료): `chain/contracts/PolicyVault.sol`, `MockKRWT.sol`, 컨트랙트 테스트 76개(`chain/test/{PolicyVault,MockKRWT,ruleCases,scripts}.test.ts` + `helpers/vault.ts`), ABI·bytecode export 스크립트(`chain/scripts/export-artifacts.ts` → `src/adapters/chain/generated/`, `npm run chain:export`를 `chain:compile`이 컴파일 후 자동 호출), 로컬 배포 스크립트(`chain/scripts/deploy-local.ts`, `npm run chain:deploy:local` → `data.local/deployments/localhost.json`), 가스 실측(`REPORT_GAS=true npm run test:contracts`) — 로컬 배포+mint 약 3.92M gas, spend 평균 130,173 gas(T-02 구현 근거, 인용)
- 2026-09-28 T-01 테스트 하네스 구축 (완료): 루트 패키지에 Next.js 16 + Vitest 설정 2개(`vitest.config.ts` 단위, `vitest.integration.config.ts` 통합), `chain/` 패키지에 Hardhat 2 + `@nomicfoundation/hardhat-toolbox-viem`, 스모크 테스트 3개(unit/integration/contracts 계층별 1개씩), `docs/CodingRules.md` "검증된 명령어" 절에 9개 명령 등록, `.env.example`에 환경 변수 14개 플레이스홀더, `.gitignore`에 3줄 추가(`.next/`, `*.tsbuildinfo`, `next-env.d.ts`)
- 2026-09-28 설계 단계 문서 작성: `docs/PRD.md`, `docs/Architecture.md`, `docs/DECISIONS.md`, ADR 3건(`docs/adr/0001-policyvault-custom-contract.md`, `0002-block-as-event-and-onchain-precheck-record.md`, `0003-evidence-sqlite-json-onchain-hash.md`)
- 2026-09-27 프로젝트 초기화 (start_coding 템플릿, 커밋 `03f65f3`)

### Changed
- 2026-09-28 `docs/CodingRules.md` "검증된 명령어"에 6개 행 추가(T-02·T-03): `chain:export`, `chain:node`, `chain:deploy:local`, `REPORT_GAS=true npm run test:contracts`, `npx tsc --noEmit -p tsconfig.json`, 통합 테스트 단일 파일 실행 명령
- 2026-09-28 architect가 D-29~D-36(`docs/DECISIONS.md`)과 ADR 0004(`docs/adr/0004-active-policy-lookup-via-event-cache.md`, 활성 정책 조회를 전체 로그 조회 → 이벤트 증분 캐시로 교체 예정)·ADR 0005(`docs/adr/0005-env-module-split-and-cli-key-file.md`, env 모듈 3분할 + CLI 전용 키 파일 `.env.cli`)를 추가. 두 ADR 모두 상태 "제안" — 사용자가 "승인 (추천)"으로 답변했으나(인용) 문서 머리글의 "승인" 전환은 사용자 소관이라 이번 세션에서 상태를 바꾸지 않음. 실제 코드 교체는 T-04 예정
- 2026-09-28 `.gitignore`에 `reference/` 제외 추가 (사용자 지시 — 제3자 문서 사본·대회 정리본을 공개 repo에 올리지 않음)

### Fixed
- 2026-09-28 통합 테스트(`npm run test:int`) 플레이키 수정: 동시에 실행된 두 `npm run test:int`가 Hardhat 노드 하나(127.0.0.1:8546)를 암묵적으로 공유해 nonce 충돌이 나던 문제를, `tests/integration/setup/hardhat-node.ts`에 잠금 파일 직렬화 + 자기 노드가 포트를 잡았는지 확인하는 로직을 추가해 해결(원인은 테스트 격리 문제이고 제품 결함이 아님 — implementer 보고, 인용). 재확인: `npm run test:int` 순차 3회 모두 "Tests 40 passed (40)", 종료 코드 0
