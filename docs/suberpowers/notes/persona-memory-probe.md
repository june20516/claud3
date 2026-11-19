# 인격 기억 기록 — SDK 확인 결과 (2026-11-19)

`docs/suberpowers/specs/2026-11-19-persona-memory-design.md` 5장의 확인. `claude-haiku-5-5`, 스트리밍 입력 `query()` 한 개, `cwd` `/tmp/…/work`, `settingSources: []`, `tools: []`. 스크립트는 버렸다.

## 1. 진행 중 읽기

- 두 번째 `result` 직후(같은 프로세스, query를 닫기 전) `getSessionMessages(sessionId, { dir: cwd })` → 4개(두 턴의 사용자·응답). 방금 끝난 턴까지 읽힌다. **접근 A 유지.**
- 메시지 객체 키: `type, uuid, session_id, message, parent_tool_use_id, parent_agent_id, timestamp`. `timestamp`는 실제로 있지만 SDK 타입(`SessionMessage`)에는 없다. 로컬 명령 결과 메시지에는 `isCompletedLocalCommand`도 붙는다.

## 2. compact 후 읽기

- 세 턴 뒤(6개) `/compact` → `result` 후 다시 읽으면 4개. 압축 전 uuid 6개 중 1개만 남았다. compact 요약 메시지는 `isCompactSummary: true`로 표시된다.
- **압축 후에는 압축 전 원문을 읽을 수 없다.** → `PreCompact`에서 기록을 기다린다(`PRECOMPACT_WAIT_MS` 20,000). 커서를 못 찾으면 마지막 compact 요약 다음부터 본다.

## 3. 훅

- `PreCompact`: `/compact`에서 불림. 입력 `session_id`, `cwd`(심볼릭 링크를 푼 실제 경로 `/private/tmp/…`), `trigger: "manual"`.
- `SessionEnd`: prompt `/clear`에서 불림(`reason: "clear"`). 그 뒤 새 `session_id`로 `init`이 다시 온다.
- `query.close()`(claud3 종료, 그리고 같은 방식으로 query를 닫는 `/resume`·`Session.replace`)에서는 2초 기다려도 불리지 않았다. → 종료·`/resume` 뒤 남은 구간은 다음 시작 때 따라잡기로 처리한다.
- `getSessionMessages`의 `dir`은 `/tmp/…`와 `/private/tmp/…` 둘 다 같은 세션을 찾았다. 훅의 `cwd`를 그대로 저장해 써도 된다.

## 비용

전체 $0.01 미만.
