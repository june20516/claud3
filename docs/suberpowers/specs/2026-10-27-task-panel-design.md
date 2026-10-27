# 서브에이전트·백그라운드 작업 표시 설계

날짜: 2026-10-27
관련: `docs/suberpowers/specs/2026-10-21-claud3-design.md`(전체 설계), `docs/suberpowers/notes/probe-results.md` "서브에이전트·백그라운드 작업 확인 (2026-10-26)"

## 1. 목적

서브에이전트나 백그라운드 작업이 도는 동안 무엇이 돌고 있는지 하단에서 한눈에 보고, 원하면 그 작업 안으로 들어가 처리 내역과 출력을 실시간으로 지켜보거나 멈출 수 있게 한다. Claude Code의 작업 표시와 비슷한 감각을 목표로 한다.

### 성공 기준

- 서브에이전트가 돌아도 메인 대화에 그 에이전트의 도구 줄이 섞이지 않는다(지금은 섞인다).
- 실행 중인 서브에이전트·백그라운드 셸이 입력창 아래 목록에 보이고, 진행(설명·경과 시간·도구 횟수·토큰)이 갱신된다.
- 목록에서 작업을 골라 관찰 패널로 들어가 에이전트 기록이나 셸 출력을 실시간으로 보고, 실행 중인 작업을 멈출 수 있다.
- 턴이 끝난 뒤 끝나는 백그라운드 작업도 메인 대화의 알림으로 알 수 있다.
- 하단 영역의 높이는 작업이 시작·종료될 때만 바뀌고, 응답이 나오는 동안 흔들리지 않는다.

### 범위 밖

- plain 화면의 목록·선택·관찰(시작·종료 한 줄만 출력한다).
- 관찰 패널 안 스크롤(PgUp/PgDn). 마지막 부분만 보인다.
- 작업을 백그라운드로 보내기(Ctrl+B, SDK `backgroundTasks`).
- 워크플로·MCP 작업의 전용 표시(종류 "기타"로 같은 목록에 보인다).

## 2. 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 관찰 화면 | 입력창 자리의 높이 고정 패널 | 지금 Ink 구조(위 Static + 아래 동적 영역)를 유지한다. 대체 화면은 실행 중 전환이 복잡하다 |
| 들어가기 | 입력창에서 ↓(입력 기록을 보고 있지 않고 여러 줄 입력 중이 아닐 때) | Claude Code와 같다 |
| 진행 요약 | `agentProgressSummaries: true` | 사용자 선택. 약 30초마다 서브에이전트 진행 한 줄 |
| 작업 내용 읽기 | 관찰 중에만 파일을 주기적으로 다시 읽는다 | 백그라운드 서브에이전트처럼 메인 스트림에 오지 않는 경우도 같은 방식으로 볼 수 있다 |
| 끝난 작업 | 다음 프롬프트를 보낼 때까지 목록에 흐리게 남긴다 | 결과를 확인하고 관찰 패널을 열 시간을 준다 |

## 3. SDK 동작 (확인 결과 요약)

- 서브에이전트의 `assistant`·`user` 메시지는 `parent_tool_use_id`(= 메인의 `Agent` tool_use id)를 달고 메인 스트림에 온다. 서브에이전트의 `stream_event`는 오지 않는다.
- `task_started`·`task_progress`·`task_updated`·`task_notification`이 작업 수명을 알린다. `task_started.tool_use_id`가 그 작업을 만든 tool_use다.
- 백그라운드 셸의 `output_file`은 실행 중에 계속 채워지고 끝나면 `[exited with code N]`이 붙는다. 셸 `task_started`에는 경로가 없고, 만든 Bash의 tool_result 문구(`Output is being written to: <경로>`)와 `task_notification.output_file`에 있다.
- 서브에이전트의 `task_id`는 agentId다. `getSubagentMessages(sessionId, task_id)`가 기록을 돌려주며, 그 메시지들에도 `parent_tool_use_id`가 붙어 있다.

## 4. 구조

### 4.1 이벤트 (`src/events.ts`, `src/types.ts`)

- `parent_tool_use_id`가 있는 `assistant`·`user`·`stream_event` 메시지는 메인 대화 이벤트(`text_delta`·`tool_start`·`tool_end`·`token_usage`)로 바꾸지 않는다.
- 새 `UiEvent`:

```ts
type TaskKind = "agent" | "shell" | "other";
type TaskEndStatus = "completed" | "failed" | "stopped";

| { type: "task_started"; taskId: string; kind: TaskKind; description: string; agentType?: string; background: boolean; toolUseId?: string }
| { type: "task_progress"; taskId: string; description: string; summary?: string; totalTokens: number; toolUses: number; durationMs: number; lastTool?: string }
| { type: "task_updated"; taskId: string; background?: boolean }
| { type: "task_output_file"; taskId?: string; toolUseId: string; outputFile: string }
| { type: "task_ended"; taskId: string; status: TaskEndStatus; summary: string; outputFile?: string }
```

- `task_type`이 `local_agent`면 `agent`, `local_bash`면 `shell`, 그 밖은 `other`.
- `ambient`이거나 `skip_transcript`인 작업은 이벤트를 내지 않는다.
- `task_output_file`: 메인 Bash tool_result 문구에서 `Output is being written to: <경로>`를 찾으면 그 tool_use id와 함께 낸다(셸 관찰을 실행 중에 시작할 수 있게). `task_ended.outputFile`로도 채워진다.

### 4.2 작업 상태 (`src/tasks.ts`, 순수 리듀서)

```ts
interface TaskInfo {
  id: string;
  kind: TaskKind;
  description: string;      // 진행 요약이 있으면 화면은 summary를 우선한다
  summary?: string;
  agentType?: string;
  background: boolean;
  status: "running" | TaskEndStatus;
  startedAt: number;        // 이 프로세스가 처음 본 시각(ms)
  endedAt?: number;
  totalTokens?: number;
  toolUses?: number;
  lastTool?: string;
  toolUseId?: string;
  outputFile?: string;
  resultSummary?: string;
}

interface TasksState { tasks: TaskInfo[] }   // 시작 순서
function reduceTasks(state: TasksState, event: UiEvent, now: number): TasksState;
function clearFinishedTasks(state: TasksState): TasksState;   // 프롬프트를 보낼 때
```

- 시작 이벤트 없이 진행·종료 이벤트가 오면 그 이벤트로 최소 작업(`kind: "other"`)을 만든다.
- `task_output_file`은 `taskId`가 있으면 그 작업에, 없으면 `toolUseId`가 같은 작업에 경로를 붙인다.
- 세션 교체(`/clear`·`/resume`)는 목록을 비운다. 재연결은 그대로 둔다.

### 4.3 작업 내용 읽기 (`src/taskOutput.ts`)

- `readShellTail(path, maxLines, readFile)`: 출력 파일의 마지막 `maxLines`줄. 파일이 없으면 빈 배열.
- `readAgentLines(sessionId, taskId, maxLines, reader)`: `getSubagentMessages`로 읽어 화면 줄로 바꾼 마지막 `maxLines`줄. 받은 프롬프트는 `> `, 응답은 마크다운, 도구 호출은 `⏺ 이름(요약)`, 도구 결과는 `  ⎿ 첫 줄`. `parent_tool_use_id`로 거르지 않는다(기록의 모든 메시지가 이 에이전트 것이다). `sessionHistory`의 블록 변환 함수를 공유하되 필터와 도구 결과 처리를 옵션으로 둔다.
- 파일 읽기와 `getSubagentMessages`는 주입받는다(테스트용).

### 4.4 Session (`src/session.ts`, `src/config.ts`)

- `SessionQuery`에 `stopTask(taskId)`를 추가하고 `Session.stopTask(taskId)`로 넘긴다. 실패는 reject해 화면이 오류를 보이게 한다.
- `buildBaseOptions`에 `agentProgressSummaries: true`.

## 5. 화면 (Ink)

### 5.1 하단 작업 목록 (`TaskList.tsx`)

- 입력창과 상태 줄 사이, 작업이 있을 때만. 최대 5줄, 넘치면 `외 N개`.
- 한 줄: 상태 기호(실행 중은 진행 표시 줄과 같은 도는 기호, 완료 `✓`, 실패·중지 `✗`) · 종류(`에이전트 <유형>`/`셸`/`작업`) · 설명(진행 요약 우선) · `백그라운드`(해당 시) · 경과 시간 · 에이전트면 `도구 N회 · N 토큰`. 폭을 넘으면 자른다.
- 끝난 작업은 흐리게. 프롬프트를 보낼 때(`startTurn`과 같은 시점) 지운다.

### 5.2 선택

- 입력창에서 ↓(입력 기록을 보고 있지 않고 여러 줄 입력 중이 아닐 때, 목록에 작업이 있을 때) → 첫 작업 선택. 입력창은 키를 받지 않는다.
- ↑/↓ 이동, Enter 관찰 패널 열기, `x` 실행 중인 작업 멈추기, Esc 또는 맨 위에서 ↑ → 입력창.
- 선택 중 작업이 사라지면(정리) 입력창으로 돌아간다.

### 5.3 관찰 패널 (`TaskPanel.tsx`)

- 입력창과 목록 자리. 높이 = 터미널 높이 − 상태 줄·진행 표시 줄·여백(최소 5줄), 고정.
- 머리줄: 종류·설명·상태·경과 시간. 본문: 4.3의 마지막 줄들(폭을 넘으면 자름). 꼬리줄: `Esc 돌아가기 · x 중지`(실행 중일 때만 `x`).
- 열려 있는 동안 1초마다 다시 읽는다. 작업이 끝나도 열어 둘 수 있다.
- 권한 질문·질문 창이 오면 패널을 닫고 그 창을 띄운다.

### 5.4 메인 대화 알림

- `task_ended` 때 흐린 한 줄: `✓ 셸 npm test 완료 · 32초`, `✗ 에이전트 code-reviewer 실패 · <요약 첫 줄>`, `✗ … 중지됨`.

### 5.5 plain 화면

- `task_started`·`task_ended` 때 흐린 한 줄씩. 목록·선택·관찰은 없다.

## 6. 오류 처리

| 상황 | 처리 |
|---|---|
| `stopTask` 실패 | `오류: 작업을 멈추지 못했습니다: …`, 목록·패널은 그대로 |
| 출력·기록 파일을 못 읽음 | 패널에 "아직 출력이 없습니다" 또는 "기록을 읽지 못했습니다: …", 다음 주기에 다시 시도 |
| 시작 없이 진행·종료 이벤트 | 최소 작업을 만들어 종료 알림을 놓치지 않는다 |
| 재연결 | 목록 유지, 이후 종료 알림으로 정리 |
| 세션 교체 | 목록 비움 |
| 터미널이 낮음 | 패널 최소 5줄 |

## 7. 테스트

- 이벤트: `test/fixtures/probe-tasks.json`으로 서브에이전트의 `echo sub-hello` 도구 호출이 `tool_start`·`tool_end`로 나오지 않고, 작업 이벤트(셸·에이전트 각각 시작·종료, 에이전트 진행, 셸 출력 파일)가 맞게 나오는지.
- `tasks.ts`: 시작→진행→종료, 끝난 작업 정리, 모르는 id, 출력 파일 연결, 세션 교체.
- `taskOutput.ts`: 셸 끝부분, 에이전트 기록 → 화면 줄(가짜 reader, probe의 서브에이전트 기록 모양).
- Ink: 목록 표시·갱신, ↓ 선택·이동·Esc, Enter 패널·주기 갱신, `x` 중지(성공·실패), 권한 질문 시 패널 닫힘, 종료 알림.
- plain: 시작·종료 한 줄.
- 실제 API는 호출하지 않는다.

## 8. 단계 (각각 PR·승격)

1. **분리와 작업 상태**: 서브에이전트 메시지 분리, 작업 이벤트, `tasks.ts`, 종료 알림(Ink·plain), plain 시작 줄, `agentProgressSummaries`.
2. **하단 작업 목록**: `TaskList`, 도는 기호, 끝난 작업 정리.
3. **선택과 관찰 패널**: ↓ 선택, `TaskPanel`, `taskOutput.ts`, 주기 갱신, `x` 중지, `Session.stopTask`.
