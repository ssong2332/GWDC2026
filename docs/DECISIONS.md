# DECISIONS — Agent Spending Control & Evidence Layer (가칭 — PRD Open Question #2)

> 소유자: architect | 결정 한 줄 로그. 배경·대안 비교가 필요한 결정은 adr/에 별도 기록하고 여기서 링크한다.
> "(제안 — OQ #n)" 표시 행은 사용자 확인 전 기본값이다. 사용자가 다른 값을 고르면 새 행으로 대체 기록한다(기존 행은 지우지 않는다).

## 결정 로그

| # | 날짜 | 결정 | 이유 (한 줄) | ADR |
|---|---|---|---|---|
| D-01 | 2026-09-28 | 단일 repo, 패키지 2개: 루트(Next.js 앱+코어+CLI)와 `chain/`(Hardhat). npm workspaces 미사용 | Hardhat(CommonJS ts-node)과 Next(bundler 해석)의 tsconfig 충돌을 피하고, 워크스페이스 호이스팅 문제를 만들지 않는다 | 해당 없음 — 한 줄 결정 |
| D-02 | 2026-09-28 | npm, Node 22.14, TypeScript 5.x | pnpm 미설치·Node 22.14 설치 확인됨(호출자 전달, 인용), PRD N-07 TS 풀스택 | 해당 없음 — 한 줄 결정 |
| D-03 | 2026-09-28 | Hardhat 2.x + `@nomicfoundation/hardhat-toolbox-viem`, 산출물 경로 `chain/build/{artifacts,cache}` | PRD N-07 Hardhat. 3.x보다 자료가 많아 1인 일정 위험이 낮다. `build/`는 기존 .gitignore가 이미 제외 | 해당 없음 — 한 줄 결정 |
| D-04 | 2026-09-28 | Solidity 0.8.24, OpenZeppelin Contracts 5.x(ERC20, SafeERC20). 역할·중지는 OZ Ownable/Pausable 없이 직접 구현 | owner·agent 두 역할이 immutable이고 차단을 revert 대신 이벤트로 남겨야 해서(ADR-0002) OZ Pausable의 revert 동작과 맞지 않는다 | 해당 없음 — 한 줄 결정 |
| D-05 | 2026-09-28 | MockKRWT: decimals 0, **1 mKRW = 1원**, "20만 원" = 200,000 mKRW. mint는 누구나 호출 가능한 테스트 토큰 (제안 — OQ #11) | 원 단위 정수로 환산이 필요 없어 금액 오류가 줄고, 영수증·UI 표시가 원화 그대로다 | 해당 없음 — 한 줄 결정 |
| D-06 | 2026-09-28 | 플랫폼 수수료: 정률 **1%(100 bps)**, `fee = floor(amount × feeBps / 10000)`, 결제 토큰으로 `FEE_RECIPIENT_ADDRESS`에 지급, 배포 시 immutable(소유자·에이전트 모두 변경 불가). 판정식 `amount + fee ≤ budget − spent − reserved`. 가스(ETH)는 예산과 무관 (제안 — OQ #13) | 정률이면 "잔여 전액 요청 → 수수료 때문에 초과" 데모(E2E 6단계)가 금액과 무관하게 재현된다. 수수료는 위임자가 정하는 값이 아니라 플랫폼 조건이다 | 해당 없음 — 한 줄 결정 |
| D-07 | 2026-09-28 | 호출 폭주 한도: 고정 창(분 = `timestamp/60`, 일 = `timestamp/86400`), 정책 필드 `maxPerMinute`·`maxPerDay`를 소유자가 setPolicy로 설정, 위임 화면 기본값 **분 3회·일 20회**. Kiln 추출 대상 아님. 차단 여부 판정 전(1~5단계) 통과한 시도만 카운트 (제안 — OQ #6) | 데모에서 4번째 시도로 차단이 재현되는 최소값이며, 정상 흐름(단계당 1건)을 막지 않는다. 한도는 사람이 확인·서명하는 값이다 | 해당 없음 — 한 줄 결정 |
| D-08 | 2026-09-28 | 대기 건은 금액+수수료를 `reserved`로 예약. `reject(requestId, evidenceHash)`(owner)로 예약 해제. 대기 건이 있으면 `setPolicy` 불가 | 승인 시점에 예산이 모자라는 경우를 없애고, 정책 교체로 대기 건의 기준이 바뀌지 않게 한다. `reject`는 PRD에 명시되지 않은 함수 — 사용자 확인 요청 | 해당 없음 — 한 줄 결정 |
| D-09 | 2026-09-28 | AI 목적 불일치(F-04 ④)는 에이전트가 `spend(…, agentReviewRequest=true, …)`로 전달, 컨트랙트는 `flags` 비트 2로 대기 처리 | 플래그는 결과를 더 엄격하게만 만든다(실행→대기) — 에이전트가 한도를 우회할 수 없다 | [ADR-0002](adr/0002-block-as-event-and-onchain-precheck-record.md) |
| D-10 | 2026-09-28 | 의도 판단 실패(무효 출력·tool call 없음·재시도 소진·402)는 fail-closed: `judgment.status`가 `invalid_output` 또는 `error`, `agentReviewRequest=true` → 사람 승인 대기 | AI가 판단하지 못한 건이 자동 결제되지 않게 한다. Kiln 호출은 그 1회뿐(F-07 ③) | 해당 없음 — 한 줄 결정 |
| D-11 | 2026-09-28 | 사전 검사 엔진은 컨트랙트 판정 순서 1~8을 그대로 미러한다 — PRD F-07이 나열한 4항목(일시정지·만료·가맹점·예산)에 **정책 미등록·폭주 한도·vault 잔액**이 더해진다. 공용 케이스 파일로 패리티 테스트 | 결정적 규칙으로 막힐 요청에 Kiln 토큰을 쓰지 않는다(F-07 취지). 항목 추가는 사용자 확인 요청 | 해당 없음 — 한 줄 결정 |
| D-12 | 2026-09-28 | 사전 차단 요청은 같은 인자 + `agentReviewRequest=true`로 온체인 제출 | 사전 검사와 채굴 사이에 상태가 바뀌어도 Kiln 판단 없는 자동 결제가 생기지 않는다 | [ADR-0002](adr/0002-block-as-event-and-onchain-precheck-record.md) |
| D-13 | 2026-09-28 | 증거 정규화 RFC 8785 JCS(npm `canonicalize`) + keccak256, 금액·cost는 문자열, tx 정보는 해시 밖 `anchor` | 언어·실행 간 같은 바이트 보장, 해시-tx 순환 제거 | [ADR-0003](adr/0003-evidence-sqlite-json-onchain-hash.md) |
| D-14 | 2026-09-28 | SQLite 드라이버 `better-sqlite3`, WAL 모드, 파일 `data.local/app.sqlite`(`.gitignore`의 `*.local`로 제외). Next 서버와 CLI가 같은 파일을 공유 | Next 번들링 호환 사례가 많고 동기 API로 단순하다. `node:sqlite`는 Node 22에서 실험 기능(추정)이고 Next 번들링 호환이 불확실해 채택하지 않는다 | 해당 없음 — 한 줄 결정 |
| D-15 | 2026-09-28 | 브라우저 지갑은 viem `custom(window.ethereum)` + React context 직접 구현. wagmi·RainbowKit 미사용 | 필요한 서명이 setPolicy·approve·reject·pause 4종뿐이라 의존성·설정을 줄인다 | 해당 없음 — 한 줄 결정 |
| D-16 | 2026-09-28 | `AGENT_PRIVATE_KEY`·`OWNER_PRIVATE_KEY`는 CLI 프로세스만 로드한다. Next 서버는 키 없이 읽기·증거 저장만 하고, 소유자 서명은 브라우저 지갑이 한다 | 로컬 웹 서버가 탈취·오용돼도 자금을 움직일 수 없다 | 해당 없음 — 한 줄 결정 |
| D-17 | 2026-09-28 | Next 서버는 `127.0.0.1`에만 바인딩. API 인증 없음 | 로컬 단일 사용자 데모(N-09). 인증 없는 `/api/policy/parse`가 Kiln 크레딧을 쓰므로 외부 노출을 막는다 | 해당 없음 — 한 줄 결정 |
| D-18 | 2026-09-28 | Qwen3 thinking 제어는 `KILN_THINKING_MODE`(`default`/`kwargs_off`/`no_think`) 설정 플래그. 기본 `default`. 키 발급 후 3가지로 같은 요청을 보내 reasoning 토큰을 비교해 기본값 확정 | 끄는 방법이 문서에 없어 추정 단계(PRD OQ #3) — 코드 변경 없이 전환·측정 가능하게 둔다 | 해당 없음 — 한 줄 결정 |
| D-19 | 2026-09-28 | Kiln 재시도: 총 4회, 429는 `x-ratelimit-reset` 우선·없으면 1/2/4s(상한 8s)+지터, 5xx·네트워크 오류 백오프, 400/401/402/403/404 무재시도. openai SDK `maxRetries: 0`, 타임아웃 90s, 비스트리밍 | PRD N-05, Kiln rate-limits 문서. 재시도 횟수를 직접 기록해 증거에 남긴다. 출력이 짧아 100초 엣지 절단 위험이 낮다 | 해당 없음 — 한 줄 결정 |
| D-20 | 2026-09-28 | 에너지 추정: `E_Wh = latency_s × cards(2) × 180W ÷ 3600`, **상한값**으로 표시, 가정·출처를 화면에 병기, "측정 아님" 명시 (제안 — OQ #9) | Kiln에 에너지 API가 없다(B). 우리가 실측할 수 있는 값은 지연뿐이다 | 해당 없음 — 한 줄 결정 |
| D-21 | 2026-09-28 | 테스트 4계층 러너: ① Hardhat test ② Vitest(unit) ③ Vitest(integration, Hardhat 노드 자동 기동, Fake Kiln) ④ `cli/e2e.ts`. CI **미사용** (제안 — OQ #14) | 1인·2일 일정에서 CI 환경 차이(네이티브 모듈 빌드 등) 해결 시간을 아낀다. 반대 선택 시 T-01에 워크플로 1개 추가 | 해당 없음 — 한 줄 결정 |
| D-22 | 2026-09-28 | 정책 기한: Kiln이 문장에서 `YYYY-MM-DD`를 뽑으면 확인 화면에 채워 두고, 없으면 빈 필수 입력. 소유자가 고치거나 넣는다. 날짜는 그 날 23:59:59 Asia/Seoul로 변환. 증거에 `expiresAtSource`(`kiln` 또는 `owner`) 기록 | OQ #15 사용자 수락 문구(호출자 전달 축어): "추천: 위임 문장에 기한이 있으면 Kiln이 뽑아냅니다. 정책 확인 화면에서 소유자가 그 값을 보고 고치거나, 없으면 직접 넣습니다. 어차피 사람이 서명 전에 확인하는 단계가 있으니 추가 비용이 작습니다." | 해당 없음 — 한 줄 결정 |
| D-23 | 2026-09-28 | 소유자 액션 증거는 서버(`/api/owner-actions/prepare`)가 만들고 해시를 반환, 브라우저가 그 해시로 서명. anchor 연결은 UI 보고가 아니라 체인 이벤트 동기화(`syncChainEvents`)로 한다 | 정규화 코드를 한 곳(서버)에만 두고, 브라우저가 confirm 전에 닫혀도 증거가 이벤트와 연결된다 | 해당 없음 — 한 줄 결정 |
| D-24 | 2026-09-28 | `owner`·`agent`·`feeRecipient`·`feeBps`·`token`은 생성자 immutable. 배포자는 agent 키(Base Sepolia에서 ETH가 필요한 지갑 수를 2개로 제한) | PRD F-03 ② 에이전트의 규칙 변경 불가를 구조로 보장. 역할 변경 요구는 PRD에 없다 | [ADR-0001](adr/0001-policyvault-custom-contract.md) |
| D-25 | 2026-09-28 | Base Sepolia E2E의 소유자 단계(setPolicy·approve·pause·unpause)는 `OWNER_PRIVATE_KEY`로 CLI가 서명. 이 키는 브라우저 지갑에 가져온 **테스트 전용 계정**이어야 한다 | 증거 생성 스크립트를 무인 재실행 가능하게 한다. UI 서명 경로(F-02·F-04 ②·F-05 ①)는 화면 시연에서 별도로 보인다. 사용자 확인 요청 | 해당 없음 — 한 줄 결정 |
| D-26 | 2026-09-28 | Kiln 호출 2종(정책 변환·의도 판단) 모두 function 1개 + `tool_choice:"auto"`, 인자는 코드에서 zod 검증. 의도 판단 프롬프트에 예산·잔액·한도를 넣지 않는다 | `response_format` 금지·structured output 미지원(K). 한도 판단을 AI에 맡기지 않는다는 핵심 가치를 프롬프트 입력 수준에서 강제 | 해당 없음 — 한 줄 결정 |
| D-27 | 2026-09-28 | 가맹점은 코드 레지스트리(daiso·coupang·gmarket, 고정 데모 주소, 개인키 없음)로 이름↔주소를 매핑. 레지스트리 밖 이름은 경고로 표시하고 정책에서 제외 | 온체인은 주소로만 판정한다. Kiln이 임의 주소를 만들어내지 못하게 enum으로 제한 | 해당 없음 — 한 줄 결정 |
| D-28 | 2026-09-28 | E2E 폭주 단계는 4건 동시 처리(viem nonceManager), 결과 "정확히 3 실행 + 1 `RATE_LIMIT_MINUTE`"를 단언 | 순차 처리 시 Kiln 지연 누적으로 분 버킷이 바뀌어 차단이 재현되지 않을 위험 | 해당 없음 — 한 줄 결정 |
