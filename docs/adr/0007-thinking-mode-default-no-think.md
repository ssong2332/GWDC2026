# ADR-0007: `KILN_THINKING_MODE` 기본값을 `no_think`로 (D-18 "기본 `default`" 대체, T-14 게이트 조건부)

> 상태: 승인 (2026-09-29, 사용자 답 "승인 (Recommended)" — 메인 세션이 대신 반영. T-14 게이트: 사용자 답 "통과 (Recommended)" — 구조 필드 6개 일치, purpose 문구 차이는 모델 편차로 기록)
> 날짜: 2026-09-29

## 맥락

D-18(2026-09-28)은 thinking 제어를 `KILN_THINKING_MODE`(`default`/`kwargs_off`/`no_think`) 플래그로 두고 "기본 `default`. 키 발급 후 3가지로 같은 요청을 보내 reasoning 토큰을 비교해 기본값 확정"으로 정했다. 이 ADR은 D-18 가운데 **기본값 한 가지만** 대체한다(플래그와 세 모드의 동작은 유지).

사용자 결정 원문(메인 세션 전달, 축어): "정책 변환도 측정하고 no_think로 변경해" (PRD OQ #16 해결 기록 — 조건부).

측정 근거 (이번 세션에 파일 직접 확인 — `evidence/thinking-ab/thinking-ab-2026-09-29T05-44-54-668Z.json`, T-11, 흐름 `intent_judge`, 모드당 3회, 9/9 HTTP 200):

| 모드 | 평균 reasoning 토큰 | 평균 total 토큰 | 평균 지연 ms | 판단 |
|---|---|---|---|---|
| `default` | 227 | 631.7 | 5952.3 | match ×3 |
| `kwargs_off` | 0 | 398 | 1159 | match ×3 |
| `no_think` | 1 | 400 | 1087.7 | match ×3 |

(파일 :190~:239, `judgmentsAgree: true` :242. 지연에는 프롬프트 캐시 영향이 섞였을 수 있다 — PRD OQ #3 한계 기록, 인용.)

제약·사실 (이번 세션 확인):

| 사실 | 근거 |
|---|---|
| 기본값은 zod `.default("default")` — env에 값이 **없을 때만** 적용된다 | src/config/env.ts:44 |
| `.env.example`의 현재 값 `KILN_THINKING_MODE=default` | .env.example:23 |
| `no_think`는 system 메시지 끝에 `/no_think` 문자열만 붙인다 | src/adapters/kiln/requestBody.ts:32~33 |
| Kiln은 목록에 없는 OpenAI 파라미터(`chat_template_kwargs` 포함)를 "forwarded … Kiln has not verified them"로 명시 | reference/kiln-docs/api-reference_chat-completions.md:70 |
| 제출 증거(Base Sepolia)의 Kiln 기록 8건은 모두 `"thinkingMode": "default"` | evidence/base-sepolia/evidence.json:853·872·891·910·929·948·967·986 |
| T-11 측정은 `intent_judge`만 — `policy_parse`에서 `no_think`가 추출 결과를 바꾸지 않는지는 미측정 | 결과 파일 :4 `"flow": "intent_judge"` / docs/Tasks.md:80 T-14 |

## 검토한 대안

| 대안 | 장점 | 단점 |
|---|---|---|
| A. `default` 유지 (D-18 그대로) | 제출 증거·지금까지 검증된 흐름과 같은 조건. 추가 검증 불필요 | reasoning 227토큰·지연 약 5.5배를 매 호출 부담(T-11 실측). 사용자 결정("no_think로 변경해")과 다르다 |
| B. `kwargs_off` | reasoning 0, total 398 — 측정상 가장 적다 | Kiln이 검증하지 않고 전달만 한다고 밝힌 파라미터에 기댄다(api-reference:70). 모델 서버 설정이 바뀌면 조용히 무시될 수 있다(추정). 사용자 선택과 다르다 |
| C. `no_think` | 모든 API가 받는 일반 입력(system 문자열)만 쓴다(requestBody.ts:32). reasoning 99.6% 감소·판단 9/9 일치(T-11). 사용자 선택 | reasoning 1토큰 잔존(빈 think 블록으로 추정 — 확인: 결과 파일의 원시 응답은 저장 안 됨, 필요 시 재측정). prompt +4토큰. 프롬프트 지시라 모델이 따르지 않을 가능성은 남는다(추정). `policy_parse` 흐름은 미측정 → T-14로 확인 |

## 결정

**C. `no_think`** — 단, **T-14 게이트 통과 후에만 적용**한다.

- 적용 조건: T-14(`policy_parse` × `default`/`no_think` × 3회)의 모드 간 필드 비교가 "일치"로 끝나야 한다. 판정 기준은 PRD OQ #24(미해결 시 보수적 기본 — 하나라도 다르면 메인 세션이 사용자에게 보고, docs/Tasks.md:80). 게이트에서 멈추면 이 ADR은 적용되지 않고 D-18의 `default`가 유효하다(상태를 "폐기" 또는 재결정으로 갱신).
- 변경 범위: 코드 기본값(src/config/env.ts:44)과 `.env.example`(:23)만(T-15). 세 모드와 플래그 자체는 D-18 그대로.
- 결정적 이유: 사용자 선택이며, 검증되지 않은 전달 파라미터가 아니라 일반 입력만으로 reasoning을 없앤다.

## 결과 (트레이드오프 포함)

- 얻는 것: 새 실행의 Kiln 호출마다 reasoning 토큰·지연 감소(T-11 `intent_judge` 기준 total 631.7→400, 지연 5952.3→1087.7ms — 결과 파일 직접 확인값).
- 제출 증거와의 관계: **제출 증거(evidence/base-sepolia/evidence.json)는 `default`로 실행됐다** — 8건 모두 `thinkingMode: "default"`. 이 결정은 그 파일을 바꾸지 않고 재생성도 하지 않는다(T-15 범위: 재생성·실제 Kiln 호출 없음). 파일이 바뀌지 않으므로 `evidence:verify` 결과도 영향받지 않을 것으로 추정(확인: T-15 후 `npm run evidence:verify -- --file evidence/base-sepolia/evidence.json`의 `mismatches: 0`). 따라서 README·발표 자료의 절감 수치는 "제출 증거는 default, 기본값 변경은 이후 실행부터"로 구분해 적어야 한다(docs 단계).
- 사용자 개인 env 파일: **`.env`/`.env.cli`에 `KILN_THINKING_MODE`가 명시돼 있으면 코드 기본값은 적용되지 않는다**(env.ts:44 `.default()`는 미설정 시에만). `.env.example`을 복사해 만든 파일이면 `default`가 명시돼 있을 가능성이 높다(추정 — 에이전트는 실제 env 파일을 읽지 않는다. 확인: 사용자가 직접 해당 줄을 보거나 지운다).
- 감수하는 것: 프롬프트 지시 기반이라 모델·서빙 설정 변화에 따라 효과가 달라질 수 있다(추정). 측정 표본은 흐름당 모드별 3회뿐이다.
