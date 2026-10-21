# claud3

Max 요금제로 받은 프로모션 API 크레딧(Agent SDK 사용분에 적용)을 쓰기 위한 개인용 터미널 코딩 CLI입니다. Claude Agent SDK(TypeScript) 위에서 Claude Code와 같은 설정(`~/.claude`의 CLAUDE.md, 플러그인, 훅, MCP)으로 동작합니다.

- 설계: `docs/suberpowers/specs/2026-10-21-claud3-design.md`
- 0단계 확인 결과: `docs/suberpowers/notes/probe-results.md`
- 구현 계획: `docs/suberpowers/plans/` (다음 작업은 여기서 이어서 진행)

## 구조

| 경로 | 책임 |
|---|---|
| `src/types.ts` | `UiEvent`, 권한 요청·응답 타입 |
| `src/events.ts` | SDK 메시지 → `UiEvent` 변환 (I/O 없음). `total_cost_usd`는 query 단위 누적값 |
| `src/auth.ts` | macOS 키체인 `anthropic-api`에서 API 키 조회 |
| `src/config.ts` | 기본 SDK 옵션 (settingSources, claude_code preset, 스트리밍, env의 API 키) |
| `src/asyncQueue.ts` | SDK로 보내는 입력 대기열 |
| `src/session.ts` | `query()` 수명, 한 번에 한 턴씩 입력, 중단, 재연결, 권한 위임. 화면을 모른다 |
| `src/ui/plain.ts` | readline 화면과 권한 질문. 로직 없이 이벤트를 그리기만 한다 |
| `src/main.ts` | 인자 처리와 조립 |
| `scripts/promote.sh`, `scripts/rollback.sh` | 안정판 승격·되돌리기 |

## 명령

- `npm test` — 단위 테스트 (vitest)
- `npm run typecheck` — 타입 검사
- `npm run dev -- [옵션]` — 개발판 실행 (`tsx src/main.ts`)
- `npm run build` — `dist/` 빌드
- `npm run promote` — 현재 커밋을 안정판으로 승격 (`stable-N` 태그)
- `npm run rollback` — 안정판을 직전 태그로 되돌림

## 규칙

- 전역 `claud3` 명령은 안정판 worktree(`~/.local/share/claud3/stable`)를 가리킵니다. 이 저장소에서 고친 내용은 `npm run dev`로 확인합니다.
- 승격(`npm run promote`)과 되돌리기는 사용자가 요청할 때만 실행합니다.
- 자동 테스트에서 실제 API를 호출하지 않습니다. SDK는 `Session`의 `queryFn` 주입으로 가짜를 씁니다.
- API 키를 출력하거나 파일·로그에 남기지 않습니다. 키는 SDK 하위 프로세스의 `env`로만 넘깁니다.
- 테스트를 먼저 쓰고 실패를 확인한 뒤 구현합니다(TDD). `any` 타입은 쓰지 않습니다.
- 사용자에게 보이는 문구는 한국어로 씁니다.
