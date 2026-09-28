# ADR-0005: env 모듈 분리(서버/CLI)와 개인키 파일 `.env.cli`

> 상태: 제안
> 날짜: 2026-09-28

## 맥락

기존 설계는 `src/config/env.ts`에 `import "server-only"`를 두고 서버와 CLI가 함께 쓰게 했다. `node_modules/server-only/package.json`의 exports는 `react-server` 조건일 때만 `empty.js`, 그 외(`default`)는 `index.js`이고, `index.js`는 조건 없이 `throw new Error(...)`한다 (이번 세션 확인). tsx로 실행하는 CLI와 Vitest는 `react-server` 조건이 없으므로 import 즉시 크래시한다.

또한 개인키를 `.env`에 두면 Next.js가 `.env`를 서버 `process.env`에 자동 로드하므로(추정 — 확인: `npm run dev` 기동 로그의 `Environments:` 줄) "키는 CLI만 로드"(D-16)가 스키마 수준에서만 지켜지고 프로세스 수준에서는 깨진다.

## 검토한 대안

| 대안 | 장점 | 단점 |
|---|---|---|
| A. 현행 — `config/env.ts`에 `server-only`, CLI도 import | 파일 1개 | CLI·테스트 크래시(확인된 사실) |
| B. `server-only` 제거, 한 모듈을 서버·CLI 공용 | 단순 | 클라이언트 컴포넌트가 실수로 import해도 빌드가 막지 않음. 키 로드 문제 미해결 |
| C. 순수 스키마 모듈(`config/env.ts`) + 서버 래퍼(`server/env.ts`, `server-only`, 키 존재 시 시작 거부) + CLI 래퍼(`cli/_env.ts`, `.env`→`.env.cli` 로드). 개인키는 `.env.cli`에만 | 크래시 없음, 서버는 `server-only` 보호 유지, D-16을 런타임 검사로 강제, 스키마는 단위 테스트 가능 | 파일 2개 추가, 사용자가 키를 `.env.cli`에 넣어야 함 |

## 결정

C. 서버 보호와 CLI 실행 가능성을 동시에 만족하는 유일한 대안이며, 키가 서버 프로세스에 들어오면 시작을 거부해 D-16을 문서 규칙이 아니라 동작으로 보장한다.

## 결과 (트레이드오프 포함)

- 얻는 것: T-04 CLI가 크래시 없이 env를 쓴다. 키가 `.env`에 잘못 들어가면 Next 서버가 즉시 알려 준다.
- 감수하는 것: 사용자 설정 파일이 2개(`.env`, `.env.cli`)가 된다. `.env.cli`는 기존 `.gitignore`의 `.env.*` 패턴으로 제외된다(이번 세션 확인). `.env.example`에 두 키를 "`.env.cli`에 넣을 것" 주석과 함께 둔다(implementer, T-04).
