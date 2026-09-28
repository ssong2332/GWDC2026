# ADR-0004: 에이전트 지출의 판단 입력(활성 정책 증거) 조회 — 이벤트 증분 캐시

> 상태: 제안
> 날짜: 2026-09-28

## 맥락

`processSpendRequest`는 Kiln 의도 판단에 활성 정책의 `purpose`·`delegationText`가 필요하다. 이 값은 온체인에 없고 로컬 `policy_set` 증거 패키지에만 있다. 활성 정책과 증거를 잇는 고리는 `PolicySet(policyVersion, …, evidenceHash)` 이벤트뿐이다 (`getState()`는 evidenceHash를 반환하지 않는다).

T-03 구현(implementer 보고, 인용)은 요청마다 `reader.getLogs(deployBlock, latest)`로 전체 로그를 훑어 현재 policyVersion의 `PolicySet`을 찾는다. 로컬 노드에서는 문제없지만 Base Sepolia(블록 약 2초 — 추정)에서는 배포 후 하루면 약 43,200블록, 10,000블록 청크로 요청 1건당 getLogs 5회 이상이 되고, E2E 7단계(4건 동시)는 그 4배를 공개 RPC에 보낸다 — 레이트 리밋 위험(추정, 확인 방법: `e2e:sepolia` 7단계 RPC 429 발생 여부).

## 검토한 대안

| 대안 | 장점 | 단점 |
|---|---|---|
| A. 현행 유지 — 요청마다 deployBlock부터 전체 getLogs | 코드 변경 없음, 상태 없음 | 배포 후 시간에 비례해 RPC 호출 증가, 동시 요청 시 공개 RPC 레이트 리밋 위험 |
| B. `ChainEventRepo` 증분 캐시 — `pullNewEvents`(sync_state 커서부터 latest까지만 getLogs → 멱등 upsert) 후 캐시에서 PolicySet 조회 | 이미 설계된 `chain_events`·`sync_state` 테이블과 `syncChainEvents`를 재사용. 첫 호출 이후 요청당 getLogs 대개 1회. 서버·CLI가 같은 SQLite를 공유하므로 캐시도 공유 | processSpendRequest deps에 `chainEvents` 추가, ChainEventRepo 구현이 선행돼야 함(T-04) |
| C. 컨트랙트에 `policyEvidenceHash` 저장 + `getState()`에 포함 | 조회 O(1), 로그 불필요 | T-02(구현·테스트 완료, 인용) 컨트랙트·ABI·VaultStateSnapshot·어댑터 재작업. setPolicy 가스 증가. 이벤트와 정보 중복 |

## 결정

B. 추가 인프라 없이 이미 설계된 캐시 테이블로 호출 수를 "배포 후 경과 시간 비례"에서 "새 블록 비례"로 바꾼다.

## 결과 (트레이드오프 포함)

- 얻는 것: Base Sepolia에서 요청당 RPC 호출이 일정해진다. 같은 캐시를 활동 목록·감사·증거 내보내기가 쓴다.
- 감수하는 것: 캐시가 체인 재편성(reorg)을 반영하지 않는다(테스트넷 데모 범위에서 위험 낮음 — 추정). 동시 호출로 sync 커서가 뒤로 갈 수 있으나 재조회·멱등 upsert라 결과에 영향 없음.
- 이행: T-03의 현행 구현(A)은 로컬 검증용으로 그대로 두고, T-04에서 `ChainEventRepo`·`pullNewEvents` 구현과 함께 B로 교체한다.
