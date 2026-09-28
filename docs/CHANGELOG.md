# CHANGELOG — Agent Spending Control & Evidence Layer (가칭)

> 소유자: docs | 형식: [Keep a Changelog](https://keepachangelog.com/ko/) 축약. 최신이 위.

## [Unreleased]

### Added
- 2026-09-28 T-01 테스트 하네스 구축 (완료): 루트 패키지에 Next.js 16 + Vitest 설정 2개(`vitest.config.ts` 단위, `vitest.integration.config.ts` 통합), `chain/` 패키지에 Hardhat 2 + `@nomicfoundation/hardhat-toolbox-viem`, 스모크 테스트 3개(unit/integration/contracts 계층별 1개씩), `docs/CodingRules.md` "검증된 명령어" 절에 9개 명령 등록, `.env.example`에 환경 변수 14개 플레이스홀더, `.gitignore`에 3줄 추가(`.next/`, `*.tsbuildinfo`, `next-env.d.ts`)
- 2026-09-28 설계 단계 문서 작성: `docs/PRD.md`, `docs/Architecture.md`, `docs/DECISIONS.md`, ADR 3건(`docs/adr/0001-policyvault-custom-contract.md`, `0002-block-as-event-and-onchain-precheck-record.md`, `0003-evidence-sqlite-json-onchain-hash.md`)
- 2026-09-27 프로젝트 초기화 (start_coding 템플릿, 커밋 `03f65f3`)
