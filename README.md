# claud3

## claud3란

Max 요금제로 받은 프로모션 API 크레딧을 쓰기 위한 개인용 터미널 코딩 CLI입니다. 이 크레딧은 Agent SDK 사용분에만 적용되고 Claude Code CLI에는 적용되지 않으므로, Claude Agent SDK(TypeScript) 위에서 Claude Code와 같은 설정으로 동작하게 만들었습니다. 크레딧 만료일은 Console › Billing에서 확인합니다.

## 설치

1. Node 24 이상이 필요합니다.
2. API 키를 macOS 키체인에 등록합니다. `-w`만 쓰면 키를 프롬프트로 입력받습니다. 이미 있는 키를 교체할 때는 `-U`를 추가합니다.

   ```sh
   security add-generic-password -a "$USER" -s anthropic-api -w
   ```

   키는 크레딧이 묶인 워크스페이스(Default 워크스페이스, 연결된 계정은 본인)에서 발급한 것이어야 합니다.
3. 전역 `claud3` 명령을 설치합니다.

   ```sh
   npm install && npm run promote
   ```

## 실행

| 명령 | 설명 |
|---|---|
| `claud3` | 새 세션 시작 |
| `claud3 --model <ID>` | 모델을 지정해 시작 |
| `claud3 --resume <ID>` | 이전 세션을 이어서 시작 |
| `claud3 --help` · `--version` | 도움말 · 버전 |

기본 모델은 `~/.claude` 설정을 따릅니다.

## 세션 안에서

세션 안에서 `/help`를 입력하면 같은 내용이 나옵니다.

**명령**

| 입력 | 설명 |
|---|---|
| `/cost` | 이번 세션 비용, 전체 누적 비용, 남은 크레딧 추정 |
| `/model` | 현재 모델과 쓸 수 있는 모델 목록 |
| `/model <ID>` | 모델 바꾸기 (예: `/model claude-sonnet-5-5`). 바꾼 뒤 첫 턴은 캐시가 새로 만들어져 비쌉니다 |
| `/clear` | 새 대화 시작 |
| `/resume <ID>` | 이전 세션으로 이동 (종료할 때 세션 ID가 출력됩니다) |
| `/help` | 도움말 |
| 그 밖의 `/…` | 플러그인 스킬 등으로 Claude에게 그대로 전달 (예: `/suberpower:brainstorming`) |

**키**

| 키 | 설명 |
|---|---|
| Enter | 보내기. 줄 끝에 `\`를 붙이고 Enter를 누르면 여러 줄 입력 |
| ↑/↓ | 이전 입력 |
| Esc / Ctrl+C | 실행 중인 턴 중단. 권한 질문 중 Ctrl+C는 거부 |
| Ctrl+C 두 번 | 종료 |
| Ctrl+D | 종료 |

**권한 질문**

| 입력 | 설명 |
|---|---|
| `y` | 이번만 허용 |
| `n` | 거부 |
| `a` | 이 도구는 세션 동안 항상 허용. claud3를 끝낼 때까지 유지(`/clear`·`/resume` 후에도) |

**실행 옵션 (터미널에서)**

| 입력 | 설명 |
|---|---|
| `claud3 --model <ID>` | 모델 지정해 시작 |
| `claud3 --resume <ID>` | 세션 이어서 시작 |
| `claud3 --help` · `--version` | 도움말 · 버전 |

**개발판·안정판**

| 입력 | 설명 |
|---|---|
| `claud3` | 안정판 (승격한 커밋으로 고정) |
| `npm run dev -- [옵션]` | 저장소에서 개발판 실행 |
| 승격 요청 | Claude에게 "안정판으로 승격해 줘"처럼 요청 (`npm run promote`) |

파일을 고치는 도구는 권한 질문 앞에 변경 내용(diff)이 먼저 보이고, Claude의 답변은 마크다운 스타일(제목, 목록, 코드 블록, 굵게 등)이 적용되어 출력됩니다.

## 모델

`/model`로 쓸 수 있는 모델 목록을 확인합니다. 2026-10 기준 ID는 다음과 같습니다.

- `claude-opus-5-5`
- `claude-sonnet-5-5`
- `claude-haiku-5-5`
- `claude-fable-5-1`

모델을 바꾸면 첫 턴에 캐시가 새로 만들어져 비용이 더 듭니다.

## 비용과 크레딧

- 턴이 끝날 때마다 그 턴의 비용과 상태 줄이 표시됩니다.
- `/cost`로 이번 세션 비용, 전체 누적 비용, 남은 크레딧 추정을 확인합니다.
- 누적 비용은 `~/.config/claud3/usage.json`에 저장되며, 시작 잔액 기본값은 US$100입니다. 시작 잔액을 바꾸려면 이 파일의 `startingCreditUsd` 값을 직접 고칩니다.
- 입력 기록은 `~/.config/claud3/history`에 저장됩니다.
- 위 두 파일의 위치는 환경 변수 `CLAUD3_CONFIG_DIR`로 바꿀 수 있습니다.
- 남은 크레딧은 claud3가 기록한 비용으로 계산한 추정치입니다. 다른 곳에서 쓴 사용량은 반영되지 않으므로 정확한 잔액은 Console › Billing에서 확인하세요.
- 잔액 부족 오류가 나면 프로모션 크레딧이 소진되었거나 만료되었을 수 있으니 Console › Billing을 확인하세요.

## 기존 Claude Code 설정

`~/.claude`의 CLAUDE.md, 플러그인, 훅, MCP 설정을 그대로 사용합니다.

주의: API 키는 SDK 하위 프로세스의 환경 변수로 전달되므로, Claude가 실행하는 Bash 명령과 훅에서도 보입니다. 신뢰하지 않는 훅이나 명령을 실행하지 않도록 주의하세요.

## 개발

| 명령 | 설명 |
|---|---|
| `npm run dev -- [옵션]` | 개발판 실행 |
| `npm test` | 단위 테스트 |
| `npm run typecheck` | 타입 검사 |
| `npm run build` | `dist/` 빌드 |
| `npm run promote` | 현재 커밋을 안정판으로 승격 |
| `npm run rollback` | 안정판을 직전 태그로 되돌림 |

전역 `claud3`는 안정판 worktree를 가리키므로, 이 저장소에서 고친 내용은 `npm run dev`로 확인합니다. 구조와 규칙은 `CLAUDE.md`, 설계·계획 문서는 `docs/suberpowers/`를 참고하세요.

## 알려진 한계

- 마크다운 표는 렌더링하지 않고 원문 그대로 출력합니다.
- 화면이 단순합니다(3단계에서 Ink로 개선 예정).
- 연결이 끊기면 재연결은 한 번만 시도합니다.
