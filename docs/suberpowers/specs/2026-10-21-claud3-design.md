# claud3 설계

- 작성일: 2026-10-21
- 상태: 검토 대기

## 1. 목적

Max 요금제로 조직에 지급된 프로모션 API 크레딧(US$100, 만료 2026-11-08 UTC)을 Claude Code와 비슷한 터미널 환경에서 쓴다.

- 프로모션 크레딧 적용 대상: Agent SDK, API, Batch API, Playground, 관리형 에이전트
- Claude Code CLI는 적용 대상이 아니다. API 키로 실행하면 구매 잔액(US$0)을 기준으로 과금되어 "잔액 부족" 오류가 난다.
- 그래서 Claude Agent SDK(TypeScript) 위에 개인용 터미널 CLI `claud3`를 만든다.

### 성공 기준

1. `claud3`로 실행한 세션의 사용량이 Console에 Agent SDK로 기록되고, 프로모션 크레딧에서 차감된다.
2. 기존 `~/.claude` 설정(전역 `CLAUDE.md`, 스킬·플러그인, 훅, MCP)을 그대로 쓰며 코딩 작업을 할 수 있다.
3. 단계마다 독립적으로 쓸 수 있는 상태가 되어, 3단계를 끝내지 못해도 만료 전까지 크레딧을 쓸 수 있다.

### 범위 밖

- 배포, 다중 사용자
- Claude Code 내부 기능 재현(`/compact` UI, IDE 연동 등)
- 프로모션 크레딧 과금 분류를 우회하는 어떤 시도

## 2. 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 기반 | `@anthropic-ai/claude-agent-sdk` (TypeScript) | 크레딧 적용 대상, Claude Code와 같은 에이전트 루프 |
| 언어 | TypeScript | SDK와 Ink(3단계) 모두 TS 생태계 |
| 세션 방식 | 하나의 `query()`를 streaming input mode로 유지 | 턴 중단(`interrupt()`), 도중 모델 변경, 프로세스 재기동 비용 없음 |
| 설정 | `settingSources: ["user", "project", "local"]` + 설치된 플러그인을 `plugins`로 전달 | 기존 Claude Code 환경과 동일하게 사용 |
| 시스템 프롬프트 | `claude_code` preset | Claude Code와 같은 동작 |
| 인증 | macOS 키체인 서비스 `anthropic-api`에서 읽어 SDK 하위 프로세스 환경변수로만 전달 | 키를 파일·로그에 남기지 않음 |
| 진행 | 0 → 1 → 2 → 3 단계, 각 단계가 사용 가능한 상태 | 만료일 대응 |
| 설치 | `npm link`로 전역 `claud3` 명령 등록 | 개인용 |

## 3. 구조

```
claud3/
  src/
    auth.ts        키체인에서 API 키 조회
    config.ts      settingSources, 플러그인 경로 수집
    session.ts     query() 수명 관리: 입력 전달, 중단, 재개, 비용 누적
    events.ts      SDK 메시지 → UI 이벤트 변환 (순수 함수)
    commands.ts    claud3 자체 슬래시 명령
    ui/
      plain.ts     1·2단계 UI (readline + 색상 출력)
      ink/         3단계 TUI
    main.ts        진입점, 인자 처리
  test/
```

### 단위별 책임

- **auth**: `security find-generic-password -s anthropic-api -w`를 실행해 키를 돌려준다. 없으면 `MissingApiKeyError`를 던진다. 출력하거나 저장하지 않는다.
- **config**: SDK `Options` 중 설정 관련 부분(`settingSources`, `plugins`, `systemPrompt`, `cwd`)을 만든다. 플러그인은 `~/.claude/plugins`의 설치 목록을 읽어 활성화된 것만 로컬 경로로 넘긴다.
- **session**: UI를 모른다. `send(text)`, `interrupt()`, `setModel(name)`, `close()`와 이벤트 구독(`AsyncIterable<UiEvent>` 또는 이벤트 리스너)을 제공한다. 권한 요청은 주입받은 `PermissionPrompter`(`(request) => Promise<Decision>`)에 위임한다. 누적 비용과 세션 ID를 보관한다.
- **events**: SDK 메시지 하나를 0개 이상의 `UiEvent`로 바꾸는 순수 함수다.
- **commands**: 입력이 claud3 명령이면 처리하고, 아니면 SDK로 넘기도록 알린다.
- **ui**: 이벤트를 그리고, 입력과 권한 응답을 받는다. 비즈니스 로직은 두지 않는다.

### UiEvent

```ts
type UiEvent =
  | { type: "session_start"; sessionId: string; model: string; apiKeySource: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolUseId: string; name: string; summary: string }
  | { type: "tool_end"; toolUseId: string; isError: boolean; summary: string }
  | { type: "turn_result"; costUsd: number; totalCostUsd: number; isError: boolean; errorMessage?: string }
  | { type: "error"; message: string };
```

## 4. 데이터 흐름

1. **시작**: `auth`로 키 조회 → `config`로 옵션 구성 → `session`이 `query()`를 연다. 첫 시스템 메시지에서 `session_start` 이벤트를 내고, UI는 상단에 `API key · Agent SDK · <model>`을 표시한다.
2. **입력**: UI가 한 줄을 받는다. `commands`가 claud3 명령(`/cost` 등)이면 처리한다. 그 밖의 입력(플러그인 스킬 `/suberpower:...` 포함)은 `session.send()`로 넘긴다.
3. **응답**: SDK 메시지를 `events`가 `UiEvent`로 바꾸고, UI가 그린다. 텍스트는 `includePartialMessages`로 실시간 출력한다.
4. **권한**: SDK가 `canUseTool`을 부르면 `session`이 `PermissionPrompter`에 묻는다. 응답은 y(이번만 허용), n(거부), a(이번 세션 동안 이 도구 항상 허용)다. 설정의 allow 규칙에 해당하면 SDK가 묻지 않는다.
5. **중단**: Esc 또는 실행 중 Ctrl+C는 `interrupt()`로 현재 턴만 멈춘다. 대기 중 Ctrl+C 두 번 또는 Ctrl+D는 종료한다.
6. **종료**: 세션 ID와 누적 비용을 출력한다. `claud3 --resume <id>`로 이어서 쓴다.

## 5. 에러 처리

| 상황 | 처리 |
|---|---|
| 키체인에 키 없음 | 등록 명령(`security add-generic-password -a "$USER" -s anthropic-api -w`) 안내 후 종료 코드 1 |
| API 오류(잔액 부족, 400 등) | 메시지를 그대로 표시하고 세션 유지. 잔액 부족이면 크레딧 만료·소진 가능성 안내 |
| SDK 하위 프로세스 종료 | 오류 표시 후 마지막 세션 ID로 `resume` 재연결을 한 번 시도. 실패하면 세션 ID를 출력하고 종료 |
| 도구 실행 오류 | 모델에 그대로 전달, UI에는 빨간 한 줄 표시 |

## 6. 단계

### 0단계: 과금 경로 확인 (버릴 코드)

- 키체인 키로 SDK를 실행해 Haiku에 짧은 프롬프트 한 번을 보낸다.
- 확인:
  1. 시스템 init 메시지의 `apiKeySource`가 API 키다(구독 OAuth가 아니다).
  2. Console Usage에 Agent SDK 사용으로 기록되고 프로모션 크레딧 잔액이 줄어든다(사용자가 Console에서 확인).
- 하나라도 실패하면 이후 단계를 멈추고 다시 설계한다.

### 1단계: 최소 CLI

- `auth`, `config`, `session`, `events`, `ui/plain`, `main`
- 실시간 텍스트, 도구 실행 한 줄 표시, 권한 y/n/a, Esc 중단, `--resume`, 기존 설정·플러그인 로드
- 종료 시 세션 ID와 누적 비용 출력

### 2단계: 편의 기능

- `commands`: `/cost`, `/clear`(새 세션), `/model <name>`, `/resume <id>`, `/help`
- 상태 줄: 모델, 이번 세션 비용, 남은 크레딧 추정치
  - 추정치 = 설정한 시작 잔액(기본 US$100) − `~/.config/claud3/usage.json`에 모든 실행에 걸쳐 누적한 비용
  - SDK가 보고한 비용 기준의 추정치이며, 정확한 잔액은 Console이 기준이다
- 여러 줄 입력, 입력 기록(↑/↓)

### 3단계: Ink TUI

- 같은 `session`과 `UiEvent`를 쓰는 Ink 화면: 입력창, 스크롤되는 대화, 도구 실행 표시, 권한 요청 창, 하단 상태 줄
- `--plain`으로 1·2단계 UI 유지

## 7. 자기 개발 (self-hosting)

1단계가 끝나면 2·3단계는 `claud3` 자신으로 개발한다. 개발 중 깨진 빌드가 개발 도구 자체를 망가뜨리지 않도록 다음을 지킨다.

- **안정판과 개발판 분리**
  - 전역 `claud3` 명령은 안정판 worktree(`~/.local/share/claud3/stable`)의 빌드를 가리킨다. 이 worktree는 git 태그(`stable-N`)에 고정한다.
  - 개발은 `~/personal/claud3`의 `main`에서 한다.
  - 개발판은 `npm run dev`로 따로 실행한다.
- **승격과 되돌리기**
  - `npm run promote`: 테스트와 빌드가 통과한 현재 커밋에 다음 `stable-N` 태그를 달고, 안정판 worktree를 그 태그로 옮겨 다시 빌드한다.
  - `npm run rollback`: 안정판을 직전 태그로 되돌린다.
- **1단계 완료 기준 추가**: `claud3`로 이 저장소에 작은 수정 하나(파일 편집, 테스트 실행, 커밋)를 직접 해 본다.
- **인수인계 문서**
  - 저장소 루트의 `CLAUDE.md`에 구조, 명령, 테스트 방법, 안정판·개발판 규칙을 적는다.
  - 2·3단계 구현 계획은 `docs/suberpowers/plans/`에 두어 `claud3`가 읽고 진행할 수 있게 한다.

## 8. 테스트

- 도구: vitest
- 단위 테스트
  - `events`: 저장한 SDK 메시지 샘플 → 기대 `UiEvent` 목록
  - `config`: 임시 디렉터리에 만든 플러그인 설치 목록 → 플러그인 경로
  - `auth`: 명령 실행기를 주입해 성공·키 없음 경우
  - `commands`: 입력별 분기
  - `session`: SDK `query`를 가짜로 주입해 입력 전달, 중단, 비용 누적, 권한 위임
- 실제 API 호출은 자동 테스트에서 하지 않는다. 각 단계 끝에 수동으로 한 번 확인한다.

## 9. 미확인 사항 (구현 중 검증)

- 구독 로그인이 남은 환경에서 SDK에 `ANTHROPIC_API_KEY`를 넘겼을 때 API 키가 확실히 우선하는지 — 0단계에서 확인
- 사용량이 Agent SDK로 분류되는지 — 0단계에서 확인
- `settingSources`로 불러온 훅과 플러그인 스킬이 SDK에서 Claude Code와 같게 동작하는지 — 1단계에서 확인
- 플러그인 설치 목록 파일의 정확한 위치와 형식 — 1단계 `config` 구현 시 실제 파일로 확인
