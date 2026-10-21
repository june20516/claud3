# 0단계 확인 결과 (2026-10-21)

`scripts/probe.ts`(삭제됨)로 `claude-haiku-5-5`에 두 턴을 보낸 결과.

1. **인증**: init 메시지의 `apiKeySource`는 `ANTHROPIC_API_KEY`. 구독 로그인이 남아 있어도 `env.ANTHROPIC_API_KEY`로 넘긴 키체인 키가 쓰인다.
2. **비용**: `result.total_cost_usd`는 query 시작부터의 **누적값**이다. turn1 0.002267365, turn2 0.00443669. 턴 비용 = 현재 값 − 직전 값.
3. **플러그인**: `settingSources: ["user", "project", "local"]`만으로 `enabledPlugins`의 플러그인이 로드된다(init `plugins`에 suberpower 등 11개, `slash_commands`에 `suberpower:*`). `plugins` 옵션은 넘기지 않는다.
4. **메시지 형태**: 첫 턴은 `system`(hook_started ×n, hook_response ×n, init, status) → `stream_event` … → `assistant` → `stream_event` … → `result`. **`system:init`은 매 턴 다시 온다**(turn2도 init, status로 시작).
5. **Console 확인(사용자)**: 프로모션 크레딧이 US$100.00 → US$99.99로 줄었다. Agent SDK 사용이 프로모션 크레딧에서 차감된다.
