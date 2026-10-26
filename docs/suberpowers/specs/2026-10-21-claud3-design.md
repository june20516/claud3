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
      ink/         3단계 TUI (기본 화면)
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
  | { type: "history"; lines: string[] } // resume한 세션의 이전 대화 (추가 2026-10-26)
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
4. **권한**: SDK가 `canUseTool`을 부르면 `session`이 `PermissionPrompter`에 묻는다. 응답은 y(이번만 허용), n(거부), a(이번 세션 동안 이 도구 항상 허용)다. 설정의 allow 규칙에 해당하면 SDK가 묻지 않는다. 언제 묻는지는 권한 모드(6절 "권한 모드")가 정하고, plan 모드의 계획 승인(`ExitPlanMode`)은 y/e/n으로 따로 묻는다.
5. **중단**: Esc 또는 실행 중 Ctrl+C는 `interrupt()`로 현재 턴만 멈춘다. 대기 중 Ctrl+C 두 번 또는 Ctrl+D는 종료한다.
6. **종료**: 세션 ID와 누적 비용을 출력한다. `claud3 --resume <id>`로 이어서 쓴다. 이어서 열면 이전 대화의 마지막 100줄을 먼저 보여 준다(6절 "resume 시 이전 대화 표시").

## 5. 에러 처리

| 상황 | 처리 |
|---|---|
| 키체인에 키 없음 | 등록 명령(`security add-generic-password -a "$USER" -s anthropic-api -w`) 안내 후 종료 코드 1 |
| API 오류(잔액 부족, 400 등) | 메시지를 그대로 표시하고 세션 유지. 잔액 부족이면 크레딧 만료·소진 가능성 안내 |
| SDK 하위 프로세스 종료 | 오류 표시 후 마지막 세션 ID로 `resume` 재연결을 한 번 시도. 실패하면 세션 ID를 출력하고 종료 |
| 도구 실행 오류 | 모델에 그대로 전달, UI에는 빨간 한 줄 표시 |
| 잘못된 권한 모드 이름(`--permission-mode`, `/mode`) | `알 수 없는 권한 모드: <값> (default, acceptEdits, plan, auto)`. 실행 옵션이면 사용법과 함께 종료 코드 1, 세션 안이면 상태를 바꾸지 않음 |
| 권한 모드 변경 실패(`setPermissionMode` reject) | 이전 모드로 되돌리고 `권한 모드를 바꾸지 못했습니다: <message>` 표시 |

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
- `/model`을 인자 없이 입력하면 현재 모델과 SDK `supportedModels()`의 모델 목록(ID, 표시 이름, 설명)을 보여 준다
- 출력 스타일링 (추가 2026-10-21)
  - Edit·Write 도구는 `tool_start` 때 변경 내용을 diff로 보여 준다(추가 줄 초록 `+`, 삭제 줄 빨강 `-`). 권한 질문보다 먼저 나오므로 diff를 보고 y/n을 고를 수 있다.
  - 응답 텍스트를 줄 단위로 마크다운 렌더링한다: 제목, 굵게, 인라인 코드, 코드 블록, 목록, 인용, 링크. 표 등 나머지는 그대로 출력한다.
  - 두 기능은 화면과 무관한 함수(`diffView`, `markdown`)로 만들어 3단계 Ink 화면에서도 다시 쓴다.
- 사용자 안내 (추가 2026-10-21)
  - `/help`: 명령, 키 조작, 모델 바꾸기, 세션 이어 가기, 개발판·안정판(`npm run dev`, 승격 요청) 안내
  - 저장소 루트 `README.md`: 설치(키체인 등록, 승격), 실행 옵션, 세션 안 명령, 모델 ID, 비용·크레딧 확인 방법, 알려진 한계

### 권한 모드 (추가 2026-10-21, 2단계 이후)

SDK `permissionMode` 중 네 가지를 claud3에서 고른다. `bypassPermissions`와 `dontAsk`는 노출하지 않는다.

| 모드 | 설명(화면 문구) |
|---|---|
| `default` | 위험한 도구는 매번 묻기 |
| `acceptEdits` | 파일 편집은 묻지 않고 허용 |
| `plan` | 계획만 세우고 도구 실행 안 함 |
| `auto` | 분류기가 판단, 애매하면 묻기 |

- 확인 결과: API 키 인증에서도 `auto`가 적용된다(init `permissionMode=auto`). 옵션을 생략하면 이 환경에서는 `default`로 시작한다. 실행 중 `setPermissionMode`가 동작하고, 다음 턴의 `system:status`·`system:init`에 바뀐 값이 실린다 (`docs/suberpowers/notes/probe-results.md` "권한 모드 확인").
- **고르는 방법**
  - 실행 옵션 `--permission-mode <mode>`. 주지 않으면 claud3 설정 `~/.config/claud3/config.json`(`CLAUD3_CONFIG_DIR`로 변경)의 `permissionMode`를 쓰고(추가 2026-10-26), 그것도 없으면 SDK에 넘기지 않는다(Claude Code 설정의 `permissions.defaultMode`, 없으면 `default`). claud3 설정은 Claude Code의 기본 모드를 바꾸지 않으려고 따로 둔다. 설정 파일이 깨졌거나 모드 이름이 틀리면 stderr에 `설정 무시: ...`를 출력하고 그 값을 무시한다.
  - 세션 안 `/mode`: 현재 모드(`*` 표시)와 네 선택지·설명, 마지막 줄 `바꾸려면: /mode <이름> · Shift+Tab`. `/mode <이름>`으로 바로 바꾼다.
  - Shift+Tab: `default → acceptEdits → plan → auto → default` 순서로 순환한다. 현재 모드가 목록 밖(설정의 `dontAsk` 등)이면 `default`로 간다. 권한 질문 중에는 무시하고, 턴 실행 중과 여러 줄 입력 중에는 허용한다.
  - 모드 변경은 턴 실행 중에도 된다(`/model`과 다름).
- **구성 요소**
  - `permissionModes`(순수 모듈): 모드 목록(배열 순서 = 순환 순서), `parsePermissionMode`, `nextPermissionMode`, 설명 문구.
  - `session`: `currentPermissionMode`(SDK `PermissionMode` 타입, 시작값은 `baseOptions.permissionMode`)와 `setPermissionMode(mode)`. 새 query(`/clear`, `/resume`, 재연결)를 열 때 현재 모드를 `options.permissionMode`로 넘긴다.
  - `UiEvent`에 `{ type: "permission_mode"; mode: PermissionMode }` 추가.
  - `commands`에 `/mode`, `main`에 `--permission-mode`, `ui/plain`에 Shift+Tab·모드 변경 줄·상태 줄 표시.
- **데이터 흐름**
  - `session`은 `system:init`·`system:status`의 `permissionMode`로 현재 모드를 갱신한다. 처음 알게 된 값은 이벤트를 내지 않고, 알던 값이 바뀌면 `permission_mode`를 낸다. 같은 값이 다시 오면 무시한다.
  - `setPermissionMode`는 현재 모드를 먼저 바꾸고 이벤트를 낸 뒤 SDK 호출을 기다린다(Shift+Tab 연타 시 바뀐 값에서 이어서 순환). 실패하면 이전 값으로 되돌리고 `permission_mode`와 `error`를 낸다. 같은 모드면 아무것도 하지 않는다. query를 열기 전이면 값만 저장했다가 연결할 때 쓴다. 종료된 세션이면 `세션이 이미 종료되었습니다`를 던진다.
  - 화면은 `permission_mode` 이벤트에 `권한 모드: <모드> — <설명>` 한 줄을 출력한다(2단계 렌더 체인으로 순서 보장). 상태 줄은 `<모델> · <모드> · 세션 $… · 크레딧 잔여 추정 $…`이고, 모드를 아직 모르면 모드를 생략한다.
- **plan 모드의 계획 승인**
  - `ExitPlanMode` 권한 요청이면 `PermissionRequest.plan`(`{ text?: string; filePath?: string }`)을 채운다. 화면은 계획 본문을 마크다운 렌더러로 자르지 않고 보여 주고, 본문이 없으면 계획 파일 경로를, 둘 다 없으면 기존 요약을 보여 준다.
  - 질문: `계획을 승인할까요? [y]승인 [e]승인+편집 자동 허용 [n]계속 계획`. 계획 질문은 y/e/n만, 일반 도구 질문은 y/n/a만 받는다.
  - `PermissionDecision`에 `"allowAcceptEdits"`를 추가한다. y → 허용, e → 허용 + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]`, n → 거부(`사용자가 계획을 승인하지 않았습니다. 계획을 계속 다듬어 주세요`). 계획 승인은 "항상 허용" 목록에 넣지 않는다.
  - 승인 뒤 모드는 SDK가 정하는 값을 따르고, status 메시지로 바뀐 값이 오면 위 흐름대로 표시한다.
  - 확인 결과(`docs/suberpowers/notes/probe-results.md` "계획 승인 확인"): 입력의 계획 본문 필드는 `plan`, 경로 필드는 `planFilePath`. y(allow) 승인 뒤 모드는 `default`, e(allow + `updatedPermissions` setMode acceptEdits) 승인 뒤 모드는 `acceptEdits`이므로 updatedPermissions 방식을 채택한다. 승인 직후 `setPermissionMode("acceptEdits")`를 호출하는 대안은 필요 없었음.
- **안내**: `/help`와 README에 `--permission-mode`, `/mode`, Shift+Tab, 계획 승인 y/e/n을 추가한다. `CLAUDE.md` 구조 표에 `permissionModes`를 추가한다.

### 3단계: Ink TUI (완료 2026-10-22)

- 같은 `session`과 `UiEvent`를 쓰는 Ink 화면: 입력창, 스크롤되는 대화, 도구 실행 표시, 권한 요청 창, 하단 상태 줄
- `--plain`으로 1·2단계 UI 유지 (stdin이나 stdout이 TTY가 아니면 자동으로 plain)
- 할 수 있는 일은 plain 화면과 같다 (갱신 2026-10-22, 권한 모드 추가분 반영):
  - 상태 줄에 권한 모드를 포함하고, 모드가 바뀌면 바로 갱신한다.
  - Shift+Tab 모드 순환, `/mode`, 입력 기록(↑/↓, 파일 저장), 여러 줄 입력, Esc·Ctrl+C·Ctrl+D 동작이 같다.
  - 권한 요청 창은 도구 질문(y/a/n)과 계획 승인 질문(y/e/n) 두 종류다. 계획 본문은 대화 영역에 출력하고 창에는 질문만 둔다.
- 명령 출력(`print`)과 입력 기록 저장은 화면마다 다르므로 화면이 직접 제공한다(`UiRunOptions`, `inputHistory`).
- 구현 계획: `docs/suberpowers/plans/2026-10-21-claud3-stage3.md`
- 구현 중 바뀐 점:
  - 대화 영역 컴포넌트는 `Transcript.tsx`가 아니라 `TranscriptView.tsx`다. macOS의 대소문자 무시 파일 시스템에서 상태 리듀서 `transcript.ts`와 이름이 충돌한다.
  - header는 별도 영역이 아니라 대화 흐름 안의 dim 줄로 표시한다.
  - `(중단됨)`은 dim으로 표시한다.
  - 동적 영역을 작게 유지한다(최종 review 반영): 응답은 완성된 줄을 바로 확정(Static)하고 진행 중인 마지막 줄만 동적으로 그린다. 도구는 시작할 때 이름·요약·diff를 확정하고 동적 영역에는 실행 중 한 줄만 둔다. 오류로 끝나면 `  ⎿ 요약` 줄을 더한다. 터미널 높이를 넘겨 scrollback에 사본이 쌓이는 것을 막는다.
  - 입력창은 한 번에 들어온 글자와 Enter(한글 IME 조합 중 Return)를 줄마다 제출한다. 붙여넣기(bracketed paste)는 줄바꿈째 입력창에 넣는다.
  - 시작 잔액을 모르면 상태 줄에서 잔액만 빼고 보인다. Ctrl+D는 입력이 비어 있을 때만 종료한다.
  - Shift+Enter 줄바꿈(추가 2026-10-26): Ink를 `kittyKeyboard: { mode: "auto" }`로 띄워, 시작할 때 터미널에 kitty keyboard protocol 지원을 묻고(`CSI ? u`, 200ms) 지원하면 `disambiguateEscapeCodes`로 켠다. 그러면 Shift+Enter가 `CSI 13;2u`로 와서 Enter와 구분된다(iTerm2 지원). 입력창은 `return + shift`나 `return + meta`(Option+Enter, `ESC CR`)면 제출하지 않고 줄바꿈을 넣는다. 지원하지 않는 터미널에서는 지금처럼 `\` + Enter를 쓴다. plain(readline)은 Shift+Enter를 구분하지 못해 `\` + Enter만 쓴다. kitty 형식의 Esc·Ctrl+C·Shift+Tab도 기존과 같이 동작한다.
  - 여러 줄 입력 기록(추가 2026-10-26): 기록 파일은 한 줄에 입력 하나를 JSON 문자열로 쓴다(줄바꿈이 든 입력도 한 줄). JSON 문자열로 읽히지 않는 줄은 예전 형식으로 보고 그대로 읽는다. Ink 입력창은 Shift+Enter 여러 줄 입력을 기록하고, 줄 끝 `\`로 이어 받은 입력은 줄마다가 아니라 완성된 입력 하나로 기록한다. plain(readline)은 여러 줄 기록을 불러오면 줄바꿈이 든 한 줄로 다룬다.
  - 긴 입력의 줄 넘김(2026-10-26 수정): 입력창은 `wrap="hard"`(글자 단위)로 그리고, 커서 계산(`inputCursorOffset`)도 글자를 하나씩 놓아 넓은 글자가 남은 칸에 들어가지 않으면 다음 행으로 넘긴다. 전에는 Ink 기본 단어 단위 줄 넘김과 계산이 달라, 줄을 넘는 입력에서 실제 커서(한글 IME 조합 위치)가 글자 끝과 어긋나 글자가 겹쳐 보였다(헤드리스 터미널 에뮬레이터로 재현·확인).
  - 상태 줄 위치 정보(추가 2026-10-26): 왼쪽에 현재 디렉터리(홈은 `~`)를 옅은 파랑, git 브랜치(detached면 짧은 해시)를 옅은 초록으로, 오른쪽에 모델·모드·비용·잔액을 둔다. 오른쪽 정보를 먼저 놓고 남은 칸에 위치를 앞부분부터 잘라 넣으며, 12칸 미만이면 위치를 뺀다. 시작할 때와 턴이 끝날 때마다 다시 읽는다(`UiRunOptions.readWorkspace`, 실패는 조용히 무시). plain은 턴 끝 상태 줄 앞에 `디렉터리 (브랜치) · `를 붙인다.
  - 입력창은 터미널의 실제 커서를 커서 칸에 둔다(Ink `useCursor`). 한글 IME가 조합 중인 글자를 상태 줄 아래가 아니라 입력창에 그리게 하기 위해서다(승격 후 사용 중 발견, 2026-10-22).
  - 진행 표시 줄(대화와 입력창 사이 한 줄)은 진행 중 응답 줄(넘치면 끝부분), 실행 중 도구(여럿이면 나머지 개수), 빈 줄 중 하나만 보여 높이가 늘 같다. 응답이 나오는 동안 상태 줄이 위아래로 움직이지 않는다.
  - diff의 추가·삭제 줄은 어두운 초록·빨강 배경(256색 22·52)에 밝은 글자(256색 255, 밝은 테마에서 검은 글자가 묻혀 2026-10-26 추가)를 쓰고, Ink 화면에서는 터미널 폭 끝까지 채운다. 상태 줄은 터미널 폭 전체의 어두운 회색 띠(`#303030`)이고, 글자색은 밝은 회색(`#d0d0d0`)으로 명시한다. 터미널 기본 글자색에 맡기면 밝은 테마에서 배경과 구분되지 않기 때문이다.

### resume 시 이전 대화 표시 (추가 2026-10-26, 3단계 이후)

- `claud3 --resume <id>`와 `/resume <id>`로 세션을 열면 이전 대화의 마지막 100줄을 "── 이전 대화 ──" 머리말 아래에 먼저 그린다. plain·Ink 화면 모두 같다.
- 기록은 SDK `getSessionMessages(sessionId)`로 로컬 세션 파일에서 읽는다(API 호출 없음). `sessionHistory`가 화면과 같은 모양의 줄로 바꾼다: 사용자 입력은 `> `, 응답은 마크다운, 도구 호출은 `⏺ 이름(요약)`, 블록 사이는 빈 줄. thinking, 도구 결과, 서브에이전트 메시지, 메타·compact 요약, 슬래시 명령 기록은 뺀다. 100줄은 터미널 줄바꿈 전 논리 줄 기준이다.
- `session`은 주입받은 `loadHistory`로 기록을 읽어 SDK 메시지보다 먼저 `history` 이벤트로 보낸다. 연결이 끊겨 다시 붙을 때는 보내지 않는다. 읽지 못하면 `error` 이벤트로 알리고 대화는 계속한다.
- 세션 고르기(추가 2026-10-26): ID 없는 `/resume`과 `claud3 --resume`은 Claude Code처럼 세션 목록에서 고른다.
  - `sessionList`가 SDK `listSessions({ dir: cwd, limit: 50 })`로 이 프로젝트(와 git worktree)의 세션을 읽어 마지막 수정 시간 기준 최신순으로 정렬한다. 제목은 SDK `summary`(직접 지은 제목, 자동 요약, 첫 프롬프트 순)의 첫 줄, 시간은 `10/26 14:03 · 3분 전`(올해가 아니면 연도 포함). 지금 세션은 뺀다.
  - 고르기는 화면이 제공한다(`CommandContext.pickSession`). Ink는 `SessionPicker` 창(세션마다 제목 줄과 흐린 시간 줄, 8개씩 보이며 고른 항목을 따라 스크롤, ↑/↓·Enter·Esc, Ctrl+C 취소), plain은 번호 목록과 `번호 › `(빈 답은 취소). 화면이 고르기를 주지 않으면 사용법을 출력한다.
  - `claud3 --resume`(값 없음)은 새 세션으로 시작한 뒤 `startupCommand: "/resume"`으로 목록을 띄운다. 취소하면 새 세션으로 이어진다. node `parseArgs`가 선택적 값을 지원하지 않으므로 값 없는 `--resume`(맨 끝이거나 다음이 옵션)은 미리 빼서 `pickResume`으로 둔다.

### AskUserQuestion 처리 (추가 2026-10-26, 3단계 이후)

- 이전에는 AskUserQuestion도 일반 도구처럼 y/a/n 권한 질문을 거쳐, 허용해도 답이 전달되지 않았다.
- SDK 문서(code.claude.com/docs/en/agent-sdk/user-input) 방식대로 `canUseTool`에서 `toolName === "AskUserQuestion"`이면 권한 질문 대신 화면의 `asker`(`UserQuestionPrompter`)로 묻고 `{ behavior: "allow", updatedInput: { ...input, answers } }`를 돌려준다. `answers`는 질문 문장 → 고른 label(복수 선택은 `", "`로 이음) 또는 직접 쓴 답이다.
- 사용자가 취소하면 `deny`("사용자가 질문에 답하지 않았습니다"), 입력 형식이 맞지 않으면 묻지 않고 `deny`, 화면이 `asker`를 주지 않으면 `deny`.
- 화면은 권한 질문과 같은 대기열로 질문을 하나씩 띄운다.
  - plain: 질문과 번호 붙은 선택지를 출력하고 `답 › `으로 받는다. 번호(복수 선택은 쉼표로 여러 개)는 label로 바꾸고, 그 밖의 글은 직접 쓴 답이다. 빈 답은 다시 묻는다.
  - Ink: 권한 창 자리에 질문 창(`QuestionDialog`). ↑/↓·Enter·숫자로 고르고, 복수 선택은 Space·숫자로 체크한다. 마지막 "직접 입력"은 아래 입력창으로 답을 받는다(한글 IME 커서를 입력창이 맞추므로). 답이 끝나면 `header: 답` 요약을 대화 영역에 남긴다.
  - Esc는 취소(직접 입력 중이면 선택지로), Ctrl+C는 취소하고 턴 중단.
- 선택지의 `preview`(`toolConfig.askUserQuestion.previewFormat`)는 쓰지 않는다.
- 도구 줄 요약은 첫 질문 문장(여럿이면 `질문 N개: …`)이다.

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
  - `session`: SDK `query`를 가짜로 주입해 입력 전달, 중단, 비용 누적, 권한 위임, 권한 모드 반영·변경·실패 되돌림, 계획 승인(y/e/n)
  - `permissionModes`: 파싱, 순환 순서, 목록 밖 현재값
  - `ui/plain`: PassThrough(`terminal: true`)로 Shift+Tab(`\x1b[Z`) 입력, 모드 변경 줄, 상태 줄, 계획 질문
- 실제 API 호출은 자동 테스트에서 하지 않는다. 각 단계 끝에 수동으로 한 번 확인한다.

## 9. 미확인 사항 (확인 결과, 2026-10-21)

- 구독 로그인이 남은 환경에서 SDK에 `ANTHROPIC_API_KEY`를 넘겼을 때 API 키가 우선하는지 — **확인됨.** init의 `apiKeySource`가 `ANTHROPIC_API_KEY` (0단계)
- 사용량이 Agent SDK로 분류되는지 — **확인됨.** 프로모션 크레딧 US$100.00 → US$99.99 (0단계, 사용자 Console 확인)
- `settingSources`로 불러온 훅과 플러그인 스킬이 동작하는지 — **확인됨.** SessionStart 훅 실행(init 앞의 hook_started/hook_response), 플러그인 11개 로드, 자기 개발 확인에서 `suberpower:test-driven-development` 스킬 호출 (0·1단계)
- 플러그인 설치 목록 파일의 위치와 형식 — **불필요해짐.** `settingSources`만으로 `enabledPlugins`가 로드되어 `plugins` 옵션을 쓰지 않는다 (`docs/suberpowers/notes/probe-results.md` 3번)
- API 키 인증에서 `permissionMode: 'auto'`가 적용되는지 — **확인됨.** init `permissionMode=auto`, 실행 중 `setPermissionMode` 동작. 분류기가 실제 도구 호출을 판단하는 동작은 미확인 (권한 모드 probe)
- `ExitPlanMode` 권한 요청의 입력 필드와 승인 뒤 모드 — **확인됨.** 계획 본문 `plan`, 경로 `planFilePath`. y 승인 뒤 `default`, e 승인(`updatedPermissions` setMode acceptEdits) 뒤 `acceptEdits` (`docs/suberpowers/notes/probe-results.md` "계획 승인 확인")
- 추가 발견: `system:init`은 매 턴 다시 온다. `total_cost_usd`는 query 단위 누적값이다. `echo` 같은 읽기 전용 Bash는 권한을 묻지 않는다(Claude Code 규칙과 같음)
