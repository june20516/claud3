# claud3 권한 모드 선택 Implementation Plan

> **agentic worker에게:** REQUIRED SUB-SKILL: 이 plan을 task 단위로 구현하려면 suberpower:subagent-driven-development(권장) 또는 suberpower:executing-plans를 사용하세요. Step은 추적을 위해 checkbox(`- [ ]`) 문법을 사용합니다.

**Goal:** SDK `permissionMode` 중 `default`·`acceptEdits`·`plan`·`auto`를 `--permission-mode`, `/mode`, Shift+Tab으로 고르고, 상태 줄에 현재 모드를 보이며, plan 모드의 계획 승인을 y/e/n으로 묻는다.

**Architecture:** 모드 목록·순환·파싱은 순수 모듈 `permissionModes`가 맡는다. `Session`이 현재 모드를 소유해 SDK의 init·status 메시지로 갱신하고 `Query.setPermissionMode`로 바꾸며, 바뀌면 `permission_mode` 이벤트를 낸다. 화면·명령·실행 옵션은 모두 `Session`을 거친다. 계획 승인은 `PermissionRequest.plan`과 `PermissionDecision`의 `"allowAcceptEdits"`로 표현한다.

**Tech Stack:** 2단계와 같음(추가 의존성 없음)

**Spec:** `docs/suberpowers/specs/2026-10-21-claud3-design.md` 6절 "권한 모드", 4·5·8·9절

## Global Constraints

- 자동 테스트에서 실제 API 호출 금지(SDK는 `queryFn` 주입), `any` 금지, 사용자 문구는 한국어. TDD(실패 확인 후 구현).
- 노출하는 모드는 `default`, `acceptEdits`, `plan`, `auto` 네 개뿐이고, 이 배열 순서가 Shift+Tab 순환 순서다. `bypassPermissions`·`dontAsk`는 노출하지 않는다(설정에서 오면 그대로 보관·표시).
- 모드 설명 문구: default `위험한 도구는 매번 묻기`, acceptEdits `파일 편집은 묻지 않고 허용`, plan `계획만 세우고 도구 실행 안 함`, auto `분류기가 판단, 애매하면 묻기`.
- 모드 이름은 대소문자를 구분한다. 잘못된 이름 문구: `알 수 없는 권한 모드: <값> (default, acceptEdits, plan, auto)`.
- `--permission-mode`를 주지 않으면 SDK 옵션에 `permissionMode`를 넣지 않는다.
- 모드 변경은 턴 실행 중에도 된다. Shift+Tab은 권한 질문 중에만 무시한다.
- 색상은 `node:util`의 `styleText`만 쓴다.
- 작업 브랜치는 `feat/permission-mode`. push는 `git push -u origin feat/permission-mode`.

## Review Focus

1. Shift+Tab을 빠르게 여러 번 누름(앞선 `setPermissionMode`가 아직 끝나지 않음) → 누른 횟수만큼 순환한 모드가 최종 모드가 되고, 먼저 보낸 요청이 늦게 실패해도 더 새로운 모드를 덮어쓰지 않는다.
2. 모드를 바꾼 직후, 아직 이전 모드를 담은 init·status 메시지가 도착 → 진행 중인 변경이 있는 동안 SDK 보고값으로 되돌리지 않는다.
3. 설정의 `permissions.defaultMode`가 `dontAsk`·`bypassPermissions` → 상태 줄과 `/mode`에 그 이름이 그대로 보이고(목록의 `*` 없음), Shift+Tab은 `default`로 간다.
4. 매우 긴 계획(수백 줄)이나 닫히지 않은 코드 블록이 있는 계획 → 계획 전체가 출력된 뒤 질문 줄이 코드 블록 스타일 없이 보인다.
5. 파이프 입력 등 키를 받을 수 없는 환경 → `/mode`로 같은 기능을 모두 쓸 수 있다(Shift+Tab 없이 확인 가능한 명령 테스트로 고정).

---

### Task 1: 계획 승인 동작 확인 (실제 API, 수동 probe)

자동 테스트가 아니다. 버릴 스크립트로 한 번 실행하고 결과만 남긴다. 사용자가 이 plan을 승인한 것이 실행 승인이다.

**Files:**
- Create(실행 후 삭제): `scripts/probe-plan-mode.ts`
- Modify: `docs/suberpowers/notes/probe-results.md` (새 절 "계획 승인 확인")

- [ ] **Step 1: probe 스크립트 작성** — `src/auth.ts`의 `readApiKey`, `src/config.ts`의 `buildBaseOptions`(model `claude-haiku-5-5`), `src/asyncQueue.ts`로 streaming query를 연다. `permissionMode: "plan"`, 프롬프트 `README.md 첫 줄을 "# claud3 (테스트)"로 바꾸는 계획을 세우고 승인을 요청해 줘. 계획은 짧게.` `canUseTool`은 `ExitPlanMode`면 입력의 **키 목록과 각 값의 타입·앞 200자**를 출력하고 시나리오별 응답을 돌려준다. `Read`·`Glob`·`Grep`은 허용, `Write`는 `file_path`에 `/.claude/plans/`가 있을 때만 허용, 그 밖은 `probe: 거부`로 거부한다. `system:init`·`system:status`의 `permissionMode`와 `result`를 출력한다. API 키는 출력하지 않는다.
- [ ] **Step 2: 시나리오 실행** — 각 시나리오는 새 query로 한 턴(승인 뒤 이어지는 작업 포함)을 끝까지 받는다. 이어서 같은 query에 `1+1은? 숫자만.`을 보내 다음 턴 시작의 `permissionMode`를 기록한다.
  - A: `{ behavior: "allow", updatedInput: input }`
  - B: A + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]`
  - Run: `npx tsx scripts/probe-plan-mode.ts`
- [ ] **Step 3: 기록** — `probe-results.md`에 다음을 적는다: `ExitPlanMode` 입력의 계획 본문 필드 이름과 파일 경로 필드 이름(없으면 없음), A 승인 뒤 모드, B 승인 뒤 모드, 비용. B가 `acceptEdits`가 되지 않았다면 그 사실과 실제 모드를 적는다.
- [ ] **Step 4: 스크립트 삭제 후 Commit**

```bash
rm scripts/probe-plan-mode.ts
git add docs/suberpowers/notes/probe-results.md
git commit -m "docs: 계획 승인(ExitPlanMode) 동작 확인 결과 기록"
```

---

### Task 2: 권한 모드 목록 (`permissionModes`)

**Files:**
- Create: `src/permissionModes.ts`
- Test: `test/permissionModes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
  export const PERMISSION_MODES: readonly ["default", "acceptEdits", "plan", "auto"];
  export type SelectablePermissionMode = (typeof PERMISSION_MODES)[number];
  export const PERMISSION_MODE_DESCRIPTIONS: Record<SelectablePermissionMode, string>;
  export function unknownPermissionModeMessage(value: string): string; // 잘못된 이름 문구
  export function parsePermissionMode(text: string): SelectablePermissionMode | undefined;
  export function nextPermissionMode(current: PermissionMode | undefined): SelectablePermissionMode;
  export function describePermissionMode(mode: PermissionMode): string; // "plan — 계획만 세우고 도구 실행 안 함", 목록 밖이면 "dontAsk"
  ```

- [ ] **Step 1: 실패하는 테스트**
  - `parsePermissionMode`: 네 값 각각 그대로 반환, `"Plan"`·`"bypassPermissions"`·`""`·`" plan"` → `undefined`
  - `nextPermissionMode`: `default→acceptEdits`, `acceptEdits→plan`, `plan→auto`, `auto→default`, `undefined→acceptEdits`(모르면 default로 보고 다음), `"dontAsk"`·`"bypassPermissions"` → `"default"`
  - `describePermissionMode("plan")` === `"plan — 계획만 세우고 도구 실행 안 함"`, `describePermissionMode("dontAsk")` === `"dontAsk"`
  - `unknownPermissionModeMessage("x")` === `"알 수 없는 권한 모드: x (default, acceptEdits, plan, auto)"`
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/permissionModes.test.ts` → FAIL(모듈 없음)
- [ ] **Step 3: 구현** — 설명 문구는 Global Constraints 그대로.
- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/permissionModes.test.ts && npm run typecheck` → PASS
- [ ] **Step 5: Commit** — `feat: 권한 모드 목록·순환·파싱`

---

### Task 3: Session의 현재 권한 모드와 변경

**Files:**
- Modify: `src/types.ts`, `src/session.ts`, `src/ui/plain.ts`(`formatEvent`의 새 이벤트 case만)
- Test: `test/session.test.ts`, `test/ui-plain.test.ts`

**Interfaces:**
- Consumes: Task 2 `describePermissionMode`
- Produces:
  - `UiEvent`에 `{ type: "permission_mode"; mode: PermissionMode }`
  - `SessionQuery`에 `setPermissionMode(mode: PermissionMode): Promise<void>`
  - `Session.currentPermissionMode: PermissionMode | undefined` (getter)
  - `Session.setPermissionMode(mode: PermissionMode): Promise<void>` — SDK 실패는 reject하지 않고 이벤트로 알린다. 종료된 세션에서만 `Error("세션이 이미 종료되었습니다")`로 reject.
  - `formatEvent({ type: "permission_mode", mode })` → `\n` + dim(`권한 모드: ${describePermissionMode(mode)}`) + `\n`

- [ ] **Step 1: 실패하는 테스트** (`FakeSdk`의 query에 `setPermissionMode` 가짜 추가)
  - 시작값: `baseOptions.permissionMode: "plan"` → `currentPermissionMode === "plan"`, 첫 query options에 `permissionMode: "plan"`. 옵션 없으면 `undefined`이고 options에 키 없음.
  - 반영: init(`permissionMode: "default"`)만 수신 → `"default"`, `permission_mode` 이벤트 없음. 이어서 status(`permissionMode: "acceptEdits"`) → 이벤트 1개(`acceptEdits`). 같은 값 init 반복 → 이벤트 추가 없음.
  - 변경: `setPermissionMode("plan")` 호출 직후(await 전) `currentPermissionMode === "plan"`이고 이벤트 1개, 가짜 `setPermissionMode("plan")` 호출됨. busy여도 동작. 같은 모드면 가짜 호출·이벤트 없음.
  - 실패: 가짜가 reject → 값이 이전으로 돌아가고 `permission_mode`(이전 값)와 `error`(`권한 모드를 바꾸지 못했습니다: <message>`) 이벤트, 호출한 쪽 Promise는 resolve.
  - Review Focus 1: 첫 요청(`acceptEdits`)이 대기 중일 때 두 번째(`plan`) 호출 → 현재 `plan`. 그 뒤 첫 요청이 reject돼도 현재 값은 `plan` 그대로(되돌림은 현재 값이 실패한 요청의 값일 때만).
  - Review Focus 2: `setPermissionMode("plan")` 대기 중 init(`permissionMode: "default"`) 수신 → 현재 값 `plan` 유지, 이벤트 없음.
  - 시작 전 호출(`start()` 전) → 값만 저장, 가짜 호출 없음, 이후 `start()`의 options에 반영. 종료 후 호출 → 지정 메시지로 reject.
  - `replace()`·`replace(id)`·재연결 → 새 query options의 `permissionMode`가 현재 값.
  - `formatEvent` permission_mode 문구(색 제거 후 `권한 모드: plan — 계획만 세우고 도구 실행 안 함`).
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/session.test.ts test/ui-plain.test.ts` → 새 테스트 FAIL
- [ ] **Step 3: 구현** — `consume`의 init 처리 자리에서 `message.type === "system"`이고 subtype이 `init` 또는 `status`이며 `permissionMode`가 있으면 반영한다. 진행 중인 변경 수를 세어 0이 아닐 때는 SDK 보고값을 무시한다. `connect`가 현재 값을 `options.permissionMode`로 넘긴다(2단계 `currentModelName`과 같은 방식).
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` → PASS
- [ ] **Step 5: Commit** — `feat: Session 권한 모드 반영과 변경`

---

### Task 4: Session의 계획 승인 (`ExitPlanMode`)

**Files:**
- Modify: `src/types.ts`, `src/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 기록(`probe-results.md` "계획 승인 확인")의 필드 이름과 B 결과
- Produces:
  - `PermissionRequest.plan?: { text?: string; filePath?: string }` — `toolName === "ExitPlanMode"`일 때만 설정(필드가 하나도 없어도 빈 객체로 설정해 계획 질문임을 알린다)
  - `PermissionDecision = "allow" | "deny" | "always" | "allowAcceptEdits"`

- [ ] **Step 1: 실패하는 테스트** (가짜 query의 `canUseTool`을 options에서 꺼내 직접 호출)
  - `ExitPlanMode` 입력(Task 1에서 확인한 필드 이름 사용) → prompter가 받은 요청의 `plan.text`·`plan.filePath`가 입력 값과 같음. 필드가 없으면 `plan`이 `{}`.
  - prompter `"allow"` → `{ behavior: "allow", updatedInput: input }`
  - prompter `"allowAcceptEdits"` → Task 1 B가 `acceptEdits`였다면 결과에 `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]` 포함. 아니었다면 결과는 `allow`이고 가짜 query의 `setPermissionMode("acceptEdits")`가 호출됨.
  - prompter `"deny"` → `{ behavior: "deny", message: "사용자가 계획을 승인하지 않았습니다. 계획을 계속 다듬어 주세요" }`
  - prompter `"always"`가 와도 `ExitPlanMode`는 항상 허용 목록에 넣지 않음(두 번째 `ExitPlanMode`에서 prompter가 다시 불림).
  - 다른 도구가 `"allowAcceptEdits"`를 받으면 `allow`로 취급.
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/session.test.ts` → 새 테스트 FAIL
- [ ] **Step 3: 구현** — `canUseTool`에서 `ExitPlanMode`를 분기한다. B 결과에 따른 방식 선택은 Task 1 기록을 근거로 하고, report에 어느 쪽을 택했는지 적는다.
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` → PASS
- [ ] **Step 5: Commit** — `feat: plan 모드 계획 승인(y/e/n)을 Session에 추가`

---

### Task 5: `/mode` 명령과 `--permission-mode` 실행 옵션

**Files:**
- Modify: `src/commands.ts`, `src/config.ts`, `src/main.ts`
- Test: `test/commands.test.ts`, `test/config.test.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: Task 2 전체, Task 3 `currentPermissionMode`·`setPermissionMode`
- Produces:
  - `CommandName`에 `"mode"`, `CommandContext.session`의 `Pick`에 `"currentPermissionMode" | "setPermissionMode"` 추가
  - `BaseOptionsParams.permissionMode?: SelectablePermissionMode` — 있을 때만 `Options.permissionMode`에 넣음
  - `CliArgs.permissionMode?: SelectablePermissionMode`; `parseArgs`는 잘못된 값이면 `Error(unknownPermissionModeMessage(value))`를 던진다(기존 `main()`의 catch가 사용법과 함께 종료 코드 1로 처리)

- [ ] **Step 1: 실패하는 테스트**
  - `parseInput("/mode")` → command mode, argument `""`; `parseInput("/mode plan")` → argument `"plan"`
  - `/mode`(현재 `plan`) 출력 줄 그대로:
    ```
    현재 모드: plan
      default      위험한 도구는 매번 묻기
      acceptEdits  파일 편집은 묻지 않고 허용
    * plan         계획만 세우고 도구 실행 안 함
      auto         분류기가 판단, 애매하면 묻기
    바꾸려면: /mode <이름> · Shift+Tab
    ```
    (형식: `${current ? "*" : " "} ${mode.padEnd(12)} ${설명}`). 현재 모드가 `undefined`면 첫 줄 `현재 모드: 알 수 없음`, `dontAsk`면 `현재 모드: dontAsk`이고 `*` 없음.
  - `/mode plan` → `setPermissionMode("plan")` 호출, 명령 자체 출력 없음(화면은 `permission_mode` 이벤트로 표시). 현재와 같으면 호출 없이 `이미 plan 모드입니다`. 잘못된 이름 → 호출 없이 잘못된 이름 문구. busy여도 동작.
  - `HELP_TEXT`에 아래 줄 포함(각 묶음의 마지막 줄 뒤에 추가): 명령 `  /mode            현재 권한 모드와 선택지`, `  /mode <이름>     권한 모드 바꾸기 (default, acceptEdits, plan, auto)`; 키 `  Shift+Tab        권한 모드 순환 (default → acceptEdits → plan → auto)`; 권한 질문 `  계획 승인(plan 모드): y 승인 · e 승인+편집 자동 허용 · n 계속 계획`; 실행 옵션 `  claud3 --permission-mode <이름>  권한 모드 지정해 시작`
  - `buildBaseOptions({ ..., permissionMode: "auto" }).permissionMode === "auto"`, 생략 시 키 없음
  - `parseArgs(["--permission-mode", "plan"]).permissionMode === "plan"`, `["--permission-mode", "Plan"]` → 잘못된 이름 문구로 throw. 실행 파일 테스트(기존 `spawnSync` 패턴): 잘못된 값 → 종료 코드 1, stderr에 잘못된 이름 문구
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/commands.test.ts test/config.test.ts test/main.test.ts` → FAIL
- [ ] **Step 3: 구현** — `main.ts`의 `USAGE` 옵션에 `  --permission-mode <mode>  권한 모드 (default, acceptEdits, plan, auto)`, 조작에 `  Shift+Tab       권한 모드 순환`을 추가하고 `buildBaseOptions`에 `permissionMode`를 넘긴다.
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` → PASS
- [ ] **Step 5: Commit** — `feat: /mode 명령과 --permission-mode 실행 옵션`

---

### Task 6: 화면 — Shift+Tab, 상태 줄, 계획 질문

**Files:**
- Modify: `src/ui/plain.ts`
- Test: `test/ui-plain.test.ts`

**Interfaces:**
- Consumes: Task 2 `nextPermissionMode`, Task 3 `Session.currentPermissionMode`·`setPermissionMode`, Task 4 `PermissionRequest.plan`·`"allowAcceptEdits"`, 2단계 `createMarkdownRenderer`
- Produces:
  - `formatStatusLine(params: { model?: string; permissionMode?: PermissionMode; sessionCostUsd: number; remainingCreditUsd: number }): string` → `<model ?? 기본 모델> · <permissionMode> · 세션 $… · 크레딧 잔여 추정 $…`, 모드가 없으면 그 자리 생략
  - `export function parsePlanDecision(answer: string): PermissionDecision | undefined` — `y`/`yes`→`"allow"`, `e`→`"allowAcceptEdits"`, `n`/`no`→`"deny"`, 대소문자·앞뒤 공백 무시, 그 밖(`a` 포함) `undefined`

- [ ] **Step 1: 실패하는 테스트**
  - `formatStatusLine({ model: "m", permissionMode: "plan", sessionCostUsd: 0.0123, remainingCreditUsd: 99.5 })` 색 제거 후 `m · plan · 세션 $0.0123 · 크레딧 잔여 추정 $99.50`; 모드 없으면 `m · 세션 $0.0123 · …`
  - `parsePlanDecision`: `y`/`E`/` n `/`no`/`yes` 기대값, `a`·`""` → `undefined`
  - PassThrough + `terminal: true`, 가짜 session(`currentPermissionMode: "acceptEdits"`)에 `\x1b[Z` 입력 → `setPermissionMode("plan")` 1회. 권한 질문이 열린 동안 `\x1b[Z` → 호출 없음. 입력 줄에 아무 문자도 남지 않음(이어서 `abc\r` → `send("abc")`).
  - 계획 질문: prompter에 `{ toolName: "ExitPlanMode", summary: "…", plan: { text: "# 계획\n- 하나" } }` → 출력에 `계획`·`• 하나`가 질문보다 먼저 나오고 질문 문구 `계획을 승인할까요? [y]승인 [e]승인+편집 자동 허용 [n]계속 계획 › `. 답 `a` → 다시 묻고, `e` → `"allowAcceptEdits"`.
  - 본문 없이 `plan: { filePath: "/p/plan.md" }` → `계획 파일: /p/plan.md` 출력. `plan: {}` → 기존 요약 줄만.
  - Review Focus 4: 닫히지 않은 코드 블록(`"```\ncode"`)과 300줄 계획 → 출력 끝의 질문 줄에 청록 ANSI(`\u001b[36m`)가 없고, 계획 300줄이 모두 출력됨.
  - `turn_result` 뒤 상태 줄에 `session.currentPermissionMode`가 들어감.
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/ui-plain.test.ts` → FAIL
- [ ] **Step 3: 구현** — Shift+Tab은 기존 Esc keypress 처리 옆에서 `key.name === "tab" && key.shift`로 받는다. 계획 본문은 새 `createMarkdownRenderer()`로 `push(text + "\n") + flush()`해 질문 앞에 쓴다. 일반 도구 질문은 기존 `parseDecision`, 계획 질문은 `parsePlanDecision`을 쓴다. 기존 권한 질문 직렬화·Ctrl+C 취소 동작은 그대로 둔다.
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck && npm run build` → PASS
- [ ] **Step 5: Commit** — `feat: Shift+Tab 권한 모드 순환, 상태 줄 모드, 계획 승인 질문`

---

### Task 7: 문서와 수동 확인

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: README 갱신** — 실행 절에 `--permission-mode <mode>`, 세션 안 표(`/help` 내용과 일치)에 `/mode`·Shift+Tab·계획 승인 y/e/n, 새 절 "권한 모드"(네 모드와 설명 표, 옵션 생략 시 설정의 `defaultMode` 또는 `default`, 턴 실행 중 변경 가능, `auto`는 분류기가 판단하고 애매하면 묻는다, plan 모드의 승인 흐름). `CLAUDE.md` 구조 표에 `src/permissionModes.ts | 권한 모드 목록·순환·파싱과 설명 문구` 추가, `session`·`commands`·`ui/plain` 설명에 권한 모드 반영.
- [ ] **Step 2: 검증** — Run: `npm test && npm run typecheck && npm run build && node dist/main.js --help` → 모두 통과, 도움말에 `--permission-mode` 포함
- [ ] **Step 3: Commit** — `docs: 권한 모드 사용법을 README와 CLAUDE.md에 추가`
- [ ] **Step 4: 수동 확인 (사용자와 함께, Haiku)** — `npm run dev -- --model claude-haiku-5-5 --permission-mode plan`:
  1. 상태 줄에 `plan`, `/mode` 목록에 `* plan`
  2. Shift+Tab 네 번 → `auto`·`default`·`acceptEdits`·`plan` 줄이 차례로 출력
  3. plan 모드에서 "README.md 첫 줄을 바꾸는 계획" → 계획 본문이 보이고 y/e/n 질문, `n` → 계속 계획, 다시 요청 후 `e` → 모드가 `acceptEdits`로 바뀜(편집은 n으로 거부)
  4. `/mode auto` 후 간단한 Bash 요청 → 분류기 판단 또는 질문
  5. `/clear` 후 모드 유지
