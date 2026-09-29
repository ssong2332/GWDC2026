# CodingRules — {{PROJECT_NAME}}

> 소유자: 사용자 | 최종 수정: {{DATE}}

## 금지

- 기존 코드 스타일과 다른 새 스타일 도입 금지 (주변 코드를 따른다).
- 요청 범위 밖 파일 수정 금지.
- 주석으로 변경 이력·자기 설명 남기기 금지 (코드가 못 보여주는 제약만 주석으로).
- 테스트 없이 "동작 확인됨" 보고 금지.
- **코드 교체 시 주변 변수/문맥 소실 금지**: `replace_file_content` 사용 시 교체 범위(`StartLine`~`EndLine`)를 변경 대상 전후 1~2줄 이내로 외과적으로 한정하며, 상하위 필수 변수 선언문이나 import문이 함께 삭제되지 않도록 반드시 확인한다.
- **CSS `!important` 남용 및 무분별한 트랜지션 덮어쓰기 금지**: 기존 `transition`이 적용된 속성(`transform`, `opacity` 등)을 리셋할 때는 단일 속성 강제 주입 대신 상태 클래스(`.is-settled`) 분리 또는 `transition: none` 사전 지정을 필수로 한다.
- **`setTimeout` 다중 체이닝을 통한 UI 시퀀스 제어 금지**: 레이스 컨디션 및 유저 클릭 중복 방지를 위해 Web Animations API(`animation.finished`)나 `transitionend` Promise, 혹은 유한 상태 기계(FSM)로 상태 전이를 제어한다.

## 규칙 (언어 확정 후 채운다)

| 항목 | 규칙 |
|---|---|
| 네이밍 | |
| 포맷터/린터 | |
| 에러 처리 | |
| 로깅 | |
| 테스트 작성 기준 | |
| 디렉토리 배치 | |
| 설정 및 상수 | 수치·타이머·텍스트 등 마이크로 요구사항은 코드 내 하드코딩하지 않고 `config.js` 또는 상수 객체로 단일 진실화(Single Source of Truth)한다. |

## 검증된 명령어

성공한 원문 그대로 기록하고, 이후 변형 없이 재사용한다 (AGENTS.md 규칙). implementer는 새 행을 추가할 수 있다 — 기존 명령을 완전히 교체해야 하면(예: 패키지 매니저 변경) 옛 행을 지우지 말고 ~~취소선~~ 처리 + 교체 사유 한 줄을 남기고 새 행을 추가한다. 행 삭제는 사용자만 한다(AGENTS.md 문서 소유권).

| 용도 | 명령 (원문) | 검증일 |
|---|---|---|
| 설치 (루트 — Next 앱·코어·Vitest) | `npm install` | 2026-09-28 |
| ~~설치 (chain — Hardhat)~~ | ~~`npm --prefix chain install`~~ | ~~2026-09-28~~ |
| ↳ 교체 사유 (T-04, 2026-09-28) | 이 명령은 실행할 때마다 `chain/package.json`에 `"gwdc2026": "file:.."`(루트 자신)를 다시 추가해 `chain/node_modules/gwdc2026` → 루트 링크 순환을 만든다(재현: 의존성 제거 후 이 명령 1회 → package.json에 재추가됨). 아래 두 행으로 교체 | — |
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
| ~~로컬 배포 (실행 중인 chain:node에 MockKRWT+PolicyVault 배포, vault에 1,000,000 mint → data.local/deployments/localhost.json)~~ | ~~`npm run chain:deploy:local`~~ | ~~2026-09-28~~ |
| ↳ 교체 사유 (T-04, 2026-09-28) | D-30: 배포 경로를 `cli/deploy.ts`(`--chain localhost\|baseSepolia`) 하나로 통합, `chain/scripts/deploy-local.ts`·`chain:deploy:local` 제거. 아래 행으로 교체 | — |
| 로컬 배포 (실행 중인 chain:node에 MockKRWT+PolicyVault 배포, vault에 1,000,000 mint → data.local/deployments/localhost.json) | `npm run deploy -- --chain localhost --rpc http://127.0.0.1:8545` | 2026-09-28 |
| 테스트 ④ E2E 로컬 (chain:node 실행 중 — 배포·8단계·증거 내보내기·검증까지, 종료 코드 0 = 통과) | `npm run e2e:local` | 2026-09-28 |
| 증거 JSON 내보내기 (로컬 E2E DB → data.local/evidence/localhost/evidence.json) | `npm run evidence:export -- --chain localhost --db data.local/e2e-localhost.sqlite` | 2026-09-28 |
| 제3자 검증 (로컬 — mismatches 0이면 종료 코드 0) | `npm run evidence:verify -- --file data.local/evidence/localhost/evidence.json --rpc http://127.0.0.1:8545` | 2026-09-28 |
| 테스트 ① + 가스 표 (hardhat-gas-reporter, toolbox 내장) | `REPORT_GAS=true npm run test:contracts` (Git Bash) | 2026-09-28 |
| 타입 검사 (루트 — src·tests 전체, 산출물 없음) | `npx tsc --noEmit -p tsconfig.json` | 2026-09-28 |
| 테스트 ③ 단일 파일 (Hardhat 노드 자동 기동 포함) | `npx vitest run --config vitest.integration.config.ts tests/integration/db.test.ts` | 2026-09-28 |
| 실행 (개발 서버를 로컬 체인·가짜 Kiln으로 강제 — 사용자 env 파일이 CHAIN=baseSepolia여도 프로세스 환경 변수가 우선. chain:node 실행 + 로컬 배포 후, Git Bash) | `CHAIN=localhost KILN_MODE=fake RPC_URL=http://127.0.0.1:8545 DATABASE_PATH=data.local/app-ui-dev.sqlite npm run dev` | 2026-09-28 |
| 효율 리포트 표 (내보낸 증거 JSON → 흐름별 토큰·cost·에너지 추정(2장 시나리오) Markdown 표, .env·DB·RPC 불필요) | `npm run report:efficiency -- --file evidence/base-sepolia/evidence.json` | 2026-09-29 |
| 제3자 검증 (Base Sepolia 공개 RPC 기본값, 읽기 전용 — mismatches 0이면 종료 코드 0) | `npm run evidence:verify -- --file evidence/base-sepolia/evidence.json` | 2026-09-29 |
| 설치 (루트 — lockfile 기준, CI 검증: GitHub Actions run 36522315216, ubuntu-latest·Node 22.14) | `npm ci` | 2026-09-29 |
| CI 워크플로 (push·PR마다 자동 — `.github/workflows/test.yml`: `npm ci` → `npm --prefix chain ci` → `npm test`, 수동 실행 명령 아님) | `.github/workflows/test.yml` | 2026-09-29 |
