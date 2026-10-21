# 0단계 확인 결과 (2026-10-21)

`scripts/probe.ts`(삭제됨)로 `claude-haiku-5-5`에 두 턴을 보낸 결과.

1. **인증**: init 메시지의 `apiKeySource`는 `ANTHROPIC_API_KEY`. 구독 로그인이 남아 있어도 `env.ANTHROPIC_API_KEY`로 넘긴 키체인 키가 쓰인다.
2. **비용**: `result.total_cost_usd`는 query 시작부터의 **누적값**이다. turn1 0.002267365, turn2 0.00443669. 턴 비용 = 현재 값 − 직전 값.
3. **플러그인**: `settingSources: ["user", "project", "local"]`만으로 `enabledPlugins`의 플러그인이 로드된다(init `plugins`에 suberpower 등 11개, `slash_commands`에 `suberpower:*`). `plugins` 옵션은 넘기지 않는다.
4. **메시지 형태**: 첫 턴은 `system`(hook_started ×n, hook_response ×n, init, status) → `stream_event` … → `assistant` → `stream_event` … → `result`. **`system:init`은 매 턴 다시 온다**(turn2도 init, status로 시작).
5. **Console 확인(사용자)**: 프로모션 크레딧이 US$100.00 → US$99.99로 줄었다. Agent SDK 사용이 프로모션 크레딧에서 차감된다.

## 권한 모드 확인 (2026-10-21)

`scripts/probe-permission-mode.ts`(삭제됨)로 `claude-haiku-5-5`에 질문 한 줄을 보내 init의 `permissionMode`를 확인했다(SDK 0.3.306, 키체인 API 키 인증). 도구 요청은 모두 거부하도록 했고, 실제로 도구 호출은 없었다.

1. **옵션 생략(현재 claud3)**: init `permissionMode=default`. SDK 문서는 생략 시 auto를 쓸 수 있는 환경이면 `'auto'`로 시작한다고 하지만, 이 환경(설정에 `permissions.defaultMode` 없음)에서는 `default`로 시작했다.
2. **`permissionMode: 'auto'`로 시작**: init `permissionMode=auto`. API 키 인증에서도 `default`로 내려가지 않는다. → **auto는 빼지 않고 포함한다.**
3. **실행 중 전환**: `setPermissionMode('default')`와 `setPermissionMode('auto')`가 모두 성공했다. 다음 턴은 `system:status`(바뀐 `permissionMode` 포함) → `system:init`(바뀐 값) 순서로 시작한다.
4. **확인하지 않은 것**: auto 모드에서 분류기가 실제로 도구 호출을 승인·거부하는지는 보지 않았다(도구 호출 없는 질문만 보냄). 분류기가 판단하지 못하면 `canUseTool`로 묻는다는 것은 SDK 문서 설명이다.
5. **비용**: 5턴 합계 약 US$0.009.

## 계획 승인 확인 (2026-10-21)

`scripts/probe-plan-mode.ts`(삭제됨)로 `claude-haiku-5-5`를 `permissionMode: "plan"`으로 시작해, README 첫 줄 수정 계획을 세우고 승인을 요청하게 했다(SDK 0.3.306, 키체인 API 키 인증). `canUseTool`에서 `ExitPlanMode`를 받아 시나리오별로 응답하고, 같은 query에 `1+1은? 숫자만.`을 보내 다음 턴 init의 `permissionMode`를 기록했다.

1. **`ExitPlanMode` 입력 필드**: 키는 `plan`(문자열, 마크다운 계획 본문)과 `planFilePath`(문자열, 예: `~/.claude/plans/readme-md-iridescent-valley.md`) 두 개다. 계획 본문 필드는 `plan`, 파일 경로 필드는 `planFilePath`.
2. **A (`allow` + `updatedInput: input`)**: 승인 직후 `system:status`가 `permissionMode=default`로 바뀌었고, 다음 턴 init도 `default`. 즉 plan 모드를 벗어나 **default**로 돌아간다. 이어진 `Edit`·`Bash`는 probe가 거부했다.
3. **B (A + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]`)**: 승인 직후 `system:status`가 `acceptEdits`로 바뀌었고 다음 턴 init도 `acceptEdits`. `Edit`는 `canUseTool` 없이 실행되어 README가 실제로 수정되었다(probe 뒤 `git checkout`으로 복구). `setMode`가 의도대로 동작한다.
4. **계획 파일**: Claude가 `~/.claude/plans/`에 계획 파일을 `Write`로 만든다(plan 모드에서는 `canUseTool` 호출 없이 통과). probe가 만든 파일 2개는 기록 후 삭제했다.
5. **비용**: A 2턴 약 US$0.0065, B 2턴 약 US$0.0054. 합계 약 US$0.012.
