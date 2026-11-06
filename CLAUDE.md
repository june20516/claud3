# claud3

Max 요금제로 받은 프로모션 API 크레딧(Agent SDK 사용분에 적용)을 쓰기 위한 개인용 터미널 코딩 CLI입니다. Claude Agent SDK(TypeScript) 위에서 Claude Code와 같은 설정(`~/.claude`의 CLAUDE.md, 플러그인, 훅, MCP)으로 동작합니다.

- 설계: `docs/suberpowers/specs/2026-10-21-claud3-design.md` (인격: `docs/suberpowers/specs/2026-11-05-persona-design.md`)
- 0단계 확인 결과: `docs/suberpowers/notes/probe-results.md`
- 구현 계획: `docs/suberpowers/plans/` (다음 작업은 여기서 이어서 진행)

## 구조

| 경로 | 책임 |
|---|---|
| `src/types.ts` | `UiEvent`, 권한 요청·응답 타입 |
| `src/events.ts` | SDK 메시지 → `UiEvent` 변환 (I/O 없음). `total_cost_usd`는 query 단위 누적값. 턴의 보낸·받은 토큰(`token_usage`, 받는 중이면 글자 수로 추정) |
| `src/auth.ts` | macOS 키체인 `anthropic-api`에서 API 키 조회 |
| `src/config.ts` | 기본 SDK 옵션 (settingSources, claude_code preset, 스트리밍, env의 API 키) |
| `src/asyncQueue.ts` | SDK로 보내는 입력 대기열 |
| `src/permissionModes.ts` | 권한 모드 목록·순환·파싱과 설명 문구 |
| `src/session.ts` | `query()` 수명, 한 번에 한 턴씩 입력, 중단, 재연결, 모델 변경·목록, 세션 교체, 권한 위임, 권한 모드 반영·변경, plan 계획 승인, resume 시 이전 대화 불러오기(`history` 이벤트), AskUserQuestion 답 위임(`askUser`). 화면을 모른다 |
| `src/userQuestions.ts` | AskUserQuestion 입력 검증, 답(번호·직접 입력) 해석, 질문·답 요약 문구 |
| `src/sessionList.ts` | `listSessions`로 프로젝트 세션 목록(최신순, 제목·마지막 대화 시간) 읽기와 시간 문구 |
| `src/sessionHistory.ts` | SDK 세션 기록 → 화면 줄(마지막 100줄) 변환과 `getSessionMessages` 읽기 |
| `src/usageStore.ts` | `~/.config/claud3/usage.json`(`CLAUD3_CONFIG_DIR`로 변경)의 누적 비용·시작 잔액 읽기/쓰기 |
| `src/workspaceInfo.ts` | 상태 줄의 현재 디렉터리(`~` 축약)와 git 브랜치 읽기 |
| `src/userConfig.ts` | `~/.config/claud3/config.json`의 claud3 전용 설정(기본 권한 모드) 읽기와 우선순위 |
| `src/commands.ts` | 슬래시 명령(`/cost`·`/model`·`/mode`·`/clear`·`/resume`·`/help`·`/persona-create`) 파싱·실행과 `HELP_TEXT`. 인자 없는 `/resume`은 화면의 `pickSession`으로 고른다. `/persona-create`는 화면의 `askQuestions`·`commandSignal`과 main의 `createPersona`를 쓴다 |
| `src/diffView.ts` | Edit·Write 도구 입력을 diff 문자열(파스텔 배경 + 진한 글자, 줄 전체 폭)과 아래 요약(경로, 행·줄 수 삭제·추가)으로 변환 |
| `src/markdown.ts` | 스트리밍 텍스트를 줄 단위로 마크다운 스타일링 |
| `src/inputHistory.ts` | 입력 기록 파일 읽기/저장 (화면 공용, 한 줄에 JSON 문자열 하나라 여러 줄 입력도 저장, 예전 형식 줄도 읽음) |
| `src/persona/tuning.ts` | 인격 수치 상수(변화량·배율·반감기·경계값)와 칭찬·욕·테스트 명령·행동 줄 패턴 |
| `src/persona/profile.ts` | `PersonaProfile`·`PersonaDraft` 타입, 인격 파일 검증(`unknown`에서 좁힘), 초안 필드 걸러내기 |
| `src/persona/mood.ts` | 기분 상태 머신 (I/O 없음): 이벤트 적용(민감도·요일·커플링·업무 시간 상한), 감쇠, 방향·세기, 부호 전환 |
| `src/persona/turnEvents.ts` | 입력 반복(bigram 유사도)·칭찬·욕, 도구 성공·실패·테스트 통과, 느린 턴 → 이벤트 (I/O 없음) |
| `src/persona/signals.ts` | 시각·요일·업무 시간·쉰 시간, 메모리 여유율(darwin은 `sysctl kern.memorystatus_level`)·CPU 부하 → 이벤트 |
| `src/persona/oneShot.ts` | 도구를 제한한 one-shot `query()`와 `structured_output`(없으면 결과 글의 JSON)·비용 읽기 |
| `src/persona/actions.ts` | 행동 줄 `(…)` 추출(코드 블록 제외), 반응 찾기(인격 반응 → 기억 → Haiku 판단, 10초 시간 제한) |
| `src/persona/prompt.ts` | 시스템 append(인격 소개·규칙)와 턴별 `[이름 상태]` 문구 (I/O 없음) |
| `src/persona/store.ts` | `<configDir>/personas/`의 인격·기분 파일 읽기/쓰기, 깨진 기분 파일은 `.broken`으로 |
| `src/persona/runtime.ts` | SDK hooks(`UserPromptSubmit`·`PostToolUse(Failure)`·`Stop`)로 기분 갱신·저장·주입, 직렬화, 예외 격리, 구독 |
| `src/persona/bootstrap.ts` | `--persona` 이름으로 인격·기분을 읽어 런타임 생성, 실패 문구 |
| `src/persona/create.ts` | `/persona-create` 흐름: 참고 자료 → 조사(WebSearch·WebFetch만, 설정 격리) → 설문 → 생성 → 확인·저장 |
| `src/ui/runOptions.ts` | `UiRunOptions`(`startupCommand` 포함), `ChatUi` 타입(`prompter`·`asker`). 명령 출력(`print`)과 세션 고르기(`pickSession`)는 화면이 제공한다 |
| `src/ui/plain.ts` | readline 화면(`--plain`, TTY가 아닐 때), 상태 줄(권한 모드 포함), 여러 줄 입력, 입력 기록, 권한 질문, 계획 승인 질문, Shift+Tab 모드 순환. 로직 없이 이벤트를 그리기만 한다 |
| `src/ui/ink/index.tsx` | `createInkUi` — Ink 화면 생성·실행 (기본 화면) |
| `src/ui/ink/App.tsx` | Ink 화면 조립: 이벤트 구독, 입력·권한 흐름 |
| `src/ui/ink/transcript.ts` | `UiEvent` → 대화 상태 리듀서 (I/O 없음). 턴 진행(`startTurn`, 경과 시간·토큰) |
| `src/ui/ink/TranscriptView.tsx` | 대화 영역 그리기, 진행 표시 줄(응답 대기 표시: 도는 기호·"처리 중"·경과 시간·토큰) |
| `src/ui/ink/InputBox.tsx` | 입력창 (Shift+Enter·`\` 여러 줄, 기록, 글자 단위 줄 넘김, 한글 IME를 위한 실제 커서 위치) |
| `src/ui/ink/PermissionDialog.tsx` | 도구 권한·계획 승인 질문 |
| `src/ui/ink/QuestionDialog.tsx` | AskUserQuestion 질문 창 (선택지, 복수 체크, 직접 입력은 입력창으로) |
| `src/ui/ink/SessionPicker.tsx` | `/resume` 세션 목록 창 (최신순, 제목·시간, 스크롤) |
| `src/ui/ink/PersonaPanel.tsx` | 입력창 위 캐릭터 패널(얼굴·수치 막대·최근 행동). 응답 글에서 완성된 마지막 행동 줄을 고른다 |
| `src/ui/ink/StatusBar.tsx` | 하단 상태 줄 (폭 전체 배경 띠, 왼쪽 디렉터리·브랜치, 오른쪽 모델·모드·비용, 좁으면 디렉터리부터 자름) |
| `src/ui/ink/useBoxTop.ts` | 입력창 top 측정(실제 커서 위치용). 값이 바뀔 때만 setState — ink `useBoxMetrics`는 연속 갱신에서 "Maximum update depth"를 일으켜 쓰지 않는다 |
| `src/ui/ink/terminalSize.ts` | 터미널 폭 조회 (입력창 커서·diff 배경 폭·상태 줄 배치) |
| `src/main.ts` | 인자 처리와 조립. `--plain`이거나 stdin·stdout이 TTY가 아니면 plain 화면, 아니면 Ink 화면. `--persona`면 인격 런타임을 열어 SDK 옵션과 화면에 넘긴다 |
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
