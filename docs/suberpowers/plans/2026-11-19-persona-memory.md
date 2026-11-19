# 인격 경험 기록(기억) Implementation Plan

> **agentic worker에게:** REQUIRED SUB-SKILL: 이 plan을 task 단위로 구현하려면 suberpower:subagent-driven-development(권장) 또는 suberpower:executing-plans를 사용하세요. Step은 추적을 위해 checkbox(`- [ ]`) 문법을 사용합니다.

**Goal:** `--persona`로 켠 인격이 대화 구간마다 인상 깊은 일을 Haiku로 골라 `<이름>.memories.json`에 쌓고, 다음 세션의 시스템 append와 턴별 회상으로 꺼내며, 떠올린 기억이 기분을 조금 움직이게 한다.

**Architecture:** 순수 모듈(`experience.ts`, `segment.ts`, `recordPrompt.ts`)과 I/O 모듈(`memoryStore.ts`, `recorder.ts`)을 `src/persona/memory/`에 둔다. 구간은 SDK 세션 기록(`getSessionMessages`)에서 커서 이후를 읽는다. 런타임은 `Stop`(10턴)·`PreCompact`·`SessionEnd` 훅에서 기록기를 부르고, `UserPromptSubmit`에서 회상한다. 기록기는 기분 대기열과 따로 돈다.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`(`query`, `getSessionMessages`, hooks), vitest.

**Spec:** `docs/suberpowers/specs/2026-11-19-persona-memory-design.md` (기존 인격: `docs/suberpowers/specs/2026-11-05-persona-design.md`)

## Global Constraints

- `--persona` 없이 실행하면 동작이 하나도 다르지 않다. 기억 파일이 없는 인격의 시스템 append는 지금과 글자 하나 다르지 않다.
- 인격 파일(`PersonaProfile`) 형식과 `validateProfile`은 바꾸지 않는다(persona-lab 계약).
- 자동 테스트에서 실제 API를 호출하지 않는다. `queryFn`, 세션 기록 읽기, 디렉터리를 주입한다.
- `any` 타입 금지. 외부 입력(`unknown`)은 검증해서 좁힌다.
- 사용자에게 보이는 문구는 한국어. 기억 내용은 화면에 내지 않는다(경고 문구만).
- 기록 Haiku 호출 옵션: `model: "claude-haiku-5-5"`, `tools: []`, `settingSources: []`, `persistSession: false`, `maxTurns: 3`, `maxBudgetUsd: 0.05`, `outputFormat` JSON schema, 60초 시간 제한(`abortController`).
- 수치는 모두 `src/persona/tuning.ts`에 둔다(spec 3.2 표의 값 그대로, 이 plan이 더한 `RECALL_MIN_CHARS` 4, `MOOD_MARKERS` 20 포함).
- 인격 훅 안의 예외는 삼키고 대화를 막지 않는다. 기록기 경고는 실행당 한 번만.
- 파일 쓰기는 임시 파일 + rename(`writeJsonAtomically`).
- TDD: 테스트를 먼저 쓰고 실패를 확인한 뒤 구현한다. 각 task 끝에 `npm test`와 `npm run typecheck`가 모두 통과해야 한다.

## Review Focus

1. 정규화 후 4자 미만이거나 행동 줄(`(...)`)만 있는 입력 → 회상하지 않고 회상 이벤트도 없다(짧은 글자의 우연한 bigram 일치 방지).
2. Haiku 출력이 3개를 넘거나, 중요도가 1~3 정수가 아니거나, `summary`가 비었거나 길이를 넘음 → 유효한 항목만 앞에서 3개, 긴 글은 자르고, 깨진 항목은 버린다. 출력 전체가 형식에 안 맞으면 실패로 친다.
3. 같은 세션의 기록이 도는 중에 또 요청(10턴 + `PreCompact`) → 동시에 두 번 돌지 않고, 끝난 뒤 새 커서 기준으로 한 번 더 돈다. 대기 중 요청은 하나로 합쳐진다.
4. 기억 파일 쓰기 실패(권한 등) → 경고 한 번, 대화는 계속, 커서는 그대로(다음 기록 때 같은 구간 재시도, `failures`에는 세지 않음).
5. 다른 디렉터리에서 연 세션의 따라잡기 → 저장해 둔 `cwd`로 `getSessionMessages(sessionId, { dir: cwd })`를 부른다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| Create `src/persona/memory/experience.ts` | 타입, 파일 검증·합치기, 개수·세션 정리, 시작용 선택, 회상 선택, 회상 이벤트, 구간 기분 요약 (순수) |
| Create `src/persona/memory/segment.ts` | `SessionMessage[]` + 커서 → `Segment` (순수) |
| Create `src/persona/memory/recordPrompt.ts` | 기록 프롬프트, JSON schema, 출력 해석 (순수) |
| Create `src/persona/memory/memoryStore.ts` | `<이름>.memories.json` 읽기·저장(다시 읽어 합치기) |
| Create `src/persona/memory/recorder.ts` | 세션 등록, 기록 대기열, Haiku 호출, 따라잡기 |
| Modify `src/persona/tuning.ts` | 기억 수치 |
| Modify `src/persona/mood.ts` | `recall` 이벤트 |
| Modify `src/persona/store.ts` | `writeJsonAtomically`·`isMissingFile` export, `listPersonas`가 `.memories.json`을 인격으로 세지 않게 |
| Modify `src/sessionHistory.ts` | 거르기 함수 export |
| Modify `src/persona/prompt.ts` | "기억" 단락, 회상 줄 |
| Modify `src/persona/runtime.ts` | 훅 연결, 회상, 기분 표시점(`MoodMarker`) |
| Modify `src/persona/bootstrap.ts`, `src/main.ts` | 기억 읽기, 기록기 생성, 따라잡기 시작 |
| Tests | `test/persona-memory-experience.test.ts`, `test/persona-memory-segment.test.ts`, `test/persona-memory-recordPrompt.test.ts`, `test/persona-memory-store.test.ts`, `test/persona-memory-recorder.test.ts`, 기존 `test/persona-mood.test.ts`·`persona-prompt.test.ts`·`persona-runtime.test.ts`·`persona-bootstrap.test.ts`·`persona-store.test.ts`·`session-history` 관련 테스트 |

---

### Task 1: SDK 동작 확인과 spec 정정

**Files:**
- Create: `docs/suberpowers/notes/persona-memory-probe.md`
- Modify: `docs/suberpowers/specs/2026-11-19-persona-memory-design.md`

이 task의 스크립트는 버릴 코드다. 저장소 밖(`/tmp/claud3-memory-probe/`)에 `.mts`로 두고, SDK·`src/` 모듈은 worktree의 절대 경로로 import한다(`tsx`로 실행). Haiku(`claude-haiku-5-5`)로 짧게 확인하고, 끝나면 디렉터리를 지운다.

- [ ] **Step 1: 진행 중 읽기 확인** — 스트리밍 입력 `query()`로 두 턴을 보내고, 두 번째 `result` 직후(같은 프로세스, query를 닫기 전) `getSessionMessages(sessionId)`가 두 번째 턴의 사용자 입력·응답까지 돌려주는지 본다. 메시지 객체에 타입 밖 필드(`timestamp`, `isCompactSummary` 등)가 실제로 있는지도 적는다.
- [ ] **Step 2: compact 후 확인** — 세 턴 뒤 `/compact`를 보내고 `result` 후 `getSessionMessages`를 다시 읽는다. 압축 전 메시지 uuid들이 남아 있는지, compact 요약 메시지가 어떻게 표시되는지(`isCompactSummary`) 적는다.
- [ ] **Step 3: 훅 확인** — `hooks`에 `PreCompact`·`SessionEnd` 콜백을 넣고 `/compact`, `query.close()`에서 각각 불리는지, 입력의 `session_id`·`cwd`·`reason`을 적는다. `/clear`를 prompt로 보냈을 때 `SessionEnd`가 불리는지도 본다.
- [ ] **Step 4: 결과 기록** — `docs/suberpowers/notes/persona-memory-probe.md`에 세 확인의 관찰(명령, 메시지 개수, uuid 존재 여부, 훅 호출 여부, 비용)을 적는다.
- [ ] **Step 5: spec 정정** — 확인 결과로 spec을 고친다.
  - 5장의 분기 중 맞는 쪽으로 `PRECOMPACT_WAIT_MS`(0 또는 20,000)와 "커서를 못 찾을 때" 규칙을 확정해 4.2·4.3·3.2에 반영한다.
  - 3.1 `sessions` 항목에 `recordedUntil`(ISO, 등록 시각으로 시작, 기록 성공 때 기록 시각)을 더하고, `moodReasons`의 시간대를 "`recordedUntil` ~ 기록 시각"으로 바꾼다(`SessionMessage`에 시각 필드가 타입으로 보장되지 않음).
  - 4.4의 "강한 후보"를 "런타임이 기록한 기분 표시점(극단 진입·탈출, 부호 전환) 중 구간 시간대의 것"으로 고치고, 표시점은 메모리에만 최근 20개(`MOOD_MARKERS`)를 둔다고 적는다(따라잡기 기록에는 없음).
  - 4.2 5단계의 `maxTurns` 1을 3으로 고친다(기존 판단기와 같은 이유).
  - 결과가 접근 A를 깨면(Step 1 실패) 여기서 멈추고 사용자에게 보고한다.
- [ ] **Step 6: Commit** — `git add docs && git commit -m "docs(persona): 기억 기록 SDK 확인 결과와 spec 정정"`

---

### Task 2: 기억 수치와 `recall` 기분 이벤트

**Files:**
- Modify: `src/persona/tuning.ts`, `src/persona/mood.ts`
- Test: `test/persona-mood.test.ts`

**Interfaces:**
- Produces:
  - `tuning.ts`: `MEMORY_LIMIT = 300`, `MEMORY_SESSION_LIMIT = 20`, `RECORD_EVERY_TURNS = 10`, `STARTUP_MEMORIES = 6`, `RECALL_SIMILARITY = 0.35`, `RECALL_MAX = 2`, `RECALL_COOLDOWN_TURNS = 10`, `RECALL_MIN_CHARS = 4`, `RECALL_DELTAS: Readonly<Record<1 | 2 | 3, number>> = { 1: 3, 2: 5, 3: 8 }`, `RECORD_TIMEOUT_MS = 60_000`, `RECORD_BUDGET_USD = 0.05`, `RECORD_MAX_FAILURES = 3`, `PRECOMPACT_WAIT_MS`(Task 1 결과), `SESSION_STALE_DAYS = 30`, `MOOD_MARKERS = 20`, `SEGMENT_LIMITS = { userChars: 1_000, assistantChars: 400, totalChars: 24_000 } as const`, `RECENT_SUMMARIES_FOR_RECORD = 20`, `SUMMARY_MAX = 120`, `FEELING_MAX = 60`
  - `mood.ts`: `MoodEvent`에 `{ kind: "recall"; summary: string; stress: number; dopamine: number }` 추가. `stress`·`dopamine`은 민감도 적용 전 기본 변화량.

- [ ] **Step 1: 실패하는 테스트 작성** (`test/persona-mood.test.ts`에 `describe("recall 이벤트")`)
  - 민감도 3(배율 1)·업무 시간 아님에서 `{ kind: "recall", summary: "테스트가 드디어 통과했다", stress: 0, dopamine: 5 }` 적용 → dopamine +5, stress 0(커플링으로 dopamine에 stress 기여 없음)
  - 민감도 stress 5(×2)에서 `stress: 3, dopamine: 0` → stress +6
  - 이유 문구: `recentReasons.at(-1)?.text === "기억: 테스트가 드디어 통과했다"`; summary가 20자를 넘으면 앞 20자 + `…` (`"기억: " + "가나다라마바사아자차카타파하가나다라마바" + "…"`)
  - `failureStreak`을 바꾸지 않는다
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-mood.test.ts` Expected: FAIL(`recall` 미정의로 타입·값 불일치)
- [ ] **Step 3: 구현** — `tuning.ts`에 위 상수. `mood.ts`의 `eventDelta`에서 `recall`은 `event.stress`·`event.dopamine`에 민감도 배율(stress 양수면 요일 배율도)을 적용한다. `applyEvent`의 이유 문구는 `recall`이면 `기억: <summary 앞 20자>…`(20자 이하면 `…` 없이). `MoodEventKind`·`EVENT_LABELS` 타입은 `recall`을 `userAction`처럼 라벨 표에서 뺀다.
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 수치와 recall 기분 이벤트"`

---

### Task 3: 기억 데이터 — 타입, 검증, 합치기, 정리

**Files:**
- Create: `src/persona/memory/experience.ts`
- Test: `test/persona-memory-experience.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Importance = 1 | 2 | 3;
  export interface Experience {
    id: string; summary: string; feeling: string; importance: Importance; at: string;
    sessionId: string; moodReasons: string[]; moodDelta: { stress: number; dopamine: number };
  }
  export interface TrackedSession {
    sessionId: string; cwd: string; cursor: string | null; failures: number;
    lastSeenAt: string; lastReadAt: string | null; recordedUntil: string;
  }
  export interface MemoryFile { version: 1; experiences: Experience[]; sessions: TrackedSession[] }
  export function emptyMemoryFile(): MemoryFile;
  /** 최상위 형식이 틀리면 undefined. 항목 하나가 깨졌으면 그 항목만 버린다. 긴 summary·feeling은 자른다. */
  export function parseMemoryFile(value: unknown): MemoryFile | undefined;
  /** 중요도 낮은 것 → 같은 중요도면 at이 오래된 것부터 지워 limit개 이하로. 남은 것의 순서는 at 오름차순. */
  export function pruneExperiences(experiences: readonly Experience[], limit?: number): Experience[];
  /** lastReadAt(없으면 lastSeenAt)이 SESSION_STALE_DAYS를 넘은 세션을 빼고, lastSeenAt 최근 순 MEMORY_SESSION_LIMIT개. */
  export function trimSessions(sessions: readonly TrackedSession[], now: Date): TrackedSession[];
  /** 경험은 id 합집합(같은 id는 mine) 후 pruneExperiences. 세션은 sessionId 합집합, 양쪽에 있으면 recordedUntil이 늦은 쪽 항목 전체(같으면 mine). */
  export function mergeMemoryFiles(onDisk: MemoryFile, mine: MemoryFile): MemoryFile;
  ```
  커서 uuid만으로는 앞뒤를 알 수 없어서 `recordedUntil`로 판단한다(이 이유를 JSDoc에 적는다).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `parseMemoryFile`: 정상 파일 왕복, `version` 없음 → `undefined`, `experiences`가 배열 아님 → `undefined`, 중요도 4인 항목만 버림, `summary` 130자 → 120자, `feeling` 70자 → 60자, `cursor: null` 허용, 숫자가 아닌 `moodDelta` 항목 버림
  - `pruneExperiences`: 중요도 [1(오래됨), 1(최근), 3(가장 오래됨), 2] limit 2 → 3과 2만 남음; limit 이하면 그대로
  - `trimSessions`: `lastReadAt` 31일 전 → 빠짐, 29일 전 → 남음, `lastReadAt: null`이면 `lastSeenAt` 기준, 21개 → 최근 20개
  - `mergeMemoryFiles`: disk에만 있는 경험 유지, 같은 id는 mine, 같은 세션에서 `recordedUntil`이 늦은 쪽 커서 사용, 한쪽에만 있는 세션 유지
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-memory-experience.test.ts` Expected: FAIL(모듈 없음)
- [ ] **Step 3: 구현** — `profile.ts`의 `isRecord`·`isStringArray` 같은 도우미는 그 파일 것을 export해서 쓰거나 같은 방식으로 작성한다(`unknown`에서 좁힘).
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 파일 타입·검증·합치기·정리"`

---

### Task 4: 기억 꺼내기 — 시작용 선택, 회상, 회상 이벤트, 구간 기분 요약

**Files:**
- Modify: `src/persona/memory/experience.ts`
- Test: `test/persona-memory-experience.test.ts`

**Interfaces:**
- Consumes: Task 2의 상수·`MoodEvent`, Task 3의 `Experience`, `turnEvents.ts`의 `normalizePrompt`·`bigramSimilarity`, `actions.ts`의 `extractActionLines`, `mood.ts`의 `MoodReason`
- Produces:
  ```ts
  export interface StartupMemories { memories: Experience[]; lead?: Experience }
  /** 중요도 내림차순 → at 최근 순 STARTUP_MEMORIES개. lead는 at이 가장 늦은 경험의 sessionId에 속한 중요도 3 중 가장 최근 것. */
  export function selectStartupMemories(experiences: readonly Experience[]): StartupMemories;
  export interface RecallInput {
    prompt: string; experiences: readonly Experience[]; excludeIds: ReadonlySet<string>;
    /** id → 마지막으로 떠올린 턴 번호 */ lastRecalledTurn: ReadonlyMap<string, number>; turn: number;
  }
  /** 행동 줄을 뺀 입력을 정규화해 RECALL_MIN_CHARS 미만이면 []. 유사도 ≥ RECALL_SIMILARITY, 쿨다운·제외 대상 빼고 유사도 순 RECALL_MAX개. */
  export function recallMemories(input: RecallInput): Experience[];
  /** moodDelta 각 축의 부호 × RECALL_DELTAS[importance]. 두 축 모두 0이면 undefined. */
  export function recallEvent(experience: Experience): MoodEvent | undefined;
  export interface MoodMarker { at: string; text: string }
  export interface SegmentMood { moodReasons: string[]; moodDelta: { stress: number; dopamine: number }; strongHints: string[] }
  /** from < at ≤ to 인 이유와 표시점만. moodReasons는 이유 text(중복 제거, 순서 유지), moodDelta는 합계(반올림), strongHints는 표시점 text. */
  export function summarizeSegmentMood(reasons: readonly MoodReason[], markers: readonly MoodMarker[], from: string, to: string): SegmentMood;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**
  - `selectStartupMemories`: 중요도 3 두 개·2 다섯 개 → 3 두 개 + 2 중 최근 넷; 빈 목록 → `{ memories: [] }`, `lead` 없음; 최신 세션에 중요도 3이 있으면 `lead`, 최신 세션에 3이 없고 이전 세션에만 있으면 `lead` 없음
  - `recallMemories`: summary `"compact 명령 만들 때 main이 바뀌어 있었다"`, 입력 `"compact 명령 또 손봐야겠다"` → 회상됨; 무관한 입력 → `[]`; 입력 `"ㅇㅇ"`(Review Focus 1) → `[]`; 입력 `"(츄르를 준다)"`만 → `[]`; `excludeIds`에 든 것 제외; `lastRecalledTurn`이 `turn - 9`면 제외, `turn - 10`이면 허용; 후보 3개면 유사도 높은 2개
  - `recallEvent`: importance 2, `moodDelta { stress: -4, dopamine: 7 }` → `{ kind: "recall", summary, stress: -5, dopamine: 5 }`; `{ stress: 0, dopamine: 0 }` → `undefined`
  - `summarizeSegmentMood`: 범위 밖 이유 제외, 경계(`at === from`) 제외·(`at === to`) 포함, 같은 text 한 번만, 합계 반올림, 범위 안 표시점만 `strongHints`
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-memory-experience.test.ts` Expected: FAIL
- [ ] **Step 3: 구현** — 위 signature대로.
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 선택·회상·회상 이벤트"`

---

### Task 5: 기억 파일 읽기·저장

**Files:**
- Create: `src/persona/memory/memoryStore.ts`
- Modify: `src/persona/store.ts`
- Test: `test/persona-memory-store.test.ts`, `test/persona-store.test.ts`

**Interfaces:**
- Consumes: Task 3의 `MemoryFile`·`parseMemoryFile`·`mergeMemoryFiles`·`emptyMemoryFile`; `store.ts`의 `writeJsonAtomically`·`isMissingFile`(export로 바꿈)·`personasDir`
- Produces:
  ```ts
  export function memoriesPath(name: string, dir?: string): string; // <dir>/<name>.memories.json
  /** 없으면 빈 파일. 깨졌으면 .broken으로 옮기고 warning "기억 파일이 깨져 새로 시작합니다". */
  export async function loadMemories(name: string, dir?: string): Promise<{ file: MemoryFile; warning?: string }>;
  /** 저장 직전에 디스크 파일을 다시 읽어 mergeMemoryFiles(onDisk, file)로 합쳐 쓰고, 합친 결과를 돌려준다. 디스크 파일이 깨졌으면 합치지 않고 file을 쓴다. */
  export async function saveMemories(name: string, file: MemoryFile, dir?: string): Promise<MemoryFile>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성** (임시 디렉터리 사용)
  - 없는 파일 → `emptyMemoryFile()`
  - 저장 후 읽기 왕복
  - 깨진 JSON → `.broken` 파일 생김, 빈 파일과 경고 문구
  - 다른 프로세스가 그사이 경험을 추가한 파일이 있을 때 `saveMemories` → 두 쪽 경험이 모두 들어간 결과를 돌려주고 디스크에도 그 내용
  - 저장 후 디렉터리에 `.tmp` 파일이 남지 않음
  - `test/persona-store.test.ts`: `listPersonas`가 `yuri.json`, `yuri.mood.json`, `yuri.memories.json`이 있을 때 `["yuri"]`만
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-memory-store.test.ts test/persona-store.test.ts` Expected: FAIL
- [ ] **Step 3: 구현** — `listPersonas`는 `.memories.json`도 제외한다.
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 파일 읽기·저장"`

---

### Task 6: 대화 구간 만들기

**Files:**
- Create: `src/persona/memory/segment.ts`
- Modify: `src/sessionHistory.ts`
- Test: `test/persona-memory-segment.test.ts` (기존 `sessionHistory` 테스트는 그대로 통과해야 함)

**Interfaces:**
- Consumes: `sessionHistory.ts`에서 export로 바꾸는 `isVisible(message: SessionMessage): boolean`, `userText(content: unknown): string | undefined`, `contentOf(message: SessionMessage): unknown`, `blocksOf(content: unknown): ContentBlock[]`(타입 `ContentBlock`도 export)
- Produces:
  ```ts
  export interface SegmentLimits { userChars: number; assistantChars: number; totalChars: number }
  export interface Segment {
    /** "사용자: …", "유리: …"(displayName), "⏺ Bash (성공|실패)" 줄 */ lines: string[];
    /** 커서 이전의 마지막 사용자 입력·응답 2쌍(같은 형식). 기록 대상 아님 */ context: string[];
    lastUuid: string; userInputs: number;
  }
  /** 커서 뒤 메시지가 없으면 undefined. cursor가 null이면 처음부터. 커서를 못 찾으면 Task 1에서 확정한 규칙. */
  export function buildSegment(messages: readonly SessionMessage[], cursor: string | null, speakerName: string, limits?: SegmentLimits): Segment | undefined;
  ```
  - `lastUuid`는 거르기 전 원본 목록의 마지막 메시지 uuid다(보이지 않는 메시지 뒤에서 다시 시작하지 않도록).
  - 도구 성패: assistant의 `tool_use` id와 user 메시지의 `tool_result`(`is_error`)를 짝지어 `⏺ 이름 (성공)`/`(실패)`, 결과가 없으면 `(결과 없음)`.
  - 길이: 사용자 입력은 `userChars`, 응답은 `assistantChars`에서 자르고 `…`. 줄 합계가 `totalChars`를 넘으면 앞쪽 줄부터 버리고 맨 앞에 `(앞부분 생략)` 줄.

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 `SessionMessage` 생성 도우미로:
  - 커서 `null` → 처음부터, 커서 uuid 다음부터, 커서가 마지막 메시지면 `undefined`
  - 커서를 못 찾음 → Task 1 규칙대로(예: 마지막 compact 요약 다음부터)
  - 서브에이전트(`parent_tool_use_id` 있음)·`is_meta`·compact 요약·`<command-` 기록 제외
  - 도구 성공·실패·결과 없음 표시, 도구 출력 본문은 줄에 없음
  - 1,200자 사용자 입력 → 1,000자 + `…`; 500자 응답 → 400자 + `…`; 합계 초과 시 `(앞부분 생략)`과 뒤쪽 줄만
  - `context`는 커서 이전 마지막 2쌍, 커서 `null`이면 `[]`
  - `userInputs`는 구간의 사용자 입력 수, 응답만 있으면 0
  - `lastUuid`는 마지막 메시지가 메타여도 그 uuid
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-memory-segment.test.ts` Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과(기존 이전 대화 표시 테스트 포함)
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 기록용 대화 구간"`

---

### Task 7: 기록 프롬프트와 출력 해석

**Files:**
- Create: `src/persona/memory/recordPrompt.ts`
- Test: `test/persona-memory-recordPrompt.test.ts`

**Interfaces:**
- Consumes: `PersonaProfile`, Task 4의 `SegmentMood`, Task 6의 `Segment`
- Produces:
  ```ts
  export const RECORD_SCHEMA: Record<string, unknown>; // { experiences: [{ summary, feeling, importance(1|2|3) }] }, maxItems 3
  export interface RecordPromptInput { profile: PersonaProfile; segment: Segment; mood: SegmentMood; recentSummaries: string[] }
  export function buildRecordPrompt(input: RecordPromptInput): string;
  export type RecordedItem = Pick<Experience, "summary" | "feeling" | "importance">;
  /** 형식이 아예 틀리면 undefined(실패). 배열 안 깨진 항목은 버리고 유효한 앞 3개, 긴 글은 SUMMARY_MAX·FEELING_MAX로 자른다. */
  export function parseRecordOutput(output: unknown): RecordedItem[] | undefined;
  ```
  프롬프트에는 spec 4.4의 입력 전부와 4.5의 기준·중요도 표·"기본값은 0개" 지시를 그대로 옮긴다. 인격 소개는 `displayName`, `summary`, `relationship`, `speechExamples`, `catchphrases`. `feeling`은 그 인격의 말투로 쓰라고 지시한다. 사용자 호칭은 `relationship`에 맞춰 "사용자"로 통일해 서술한다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - 프롬프트에 인격 이름, 구간 줄, 맥락 줄(맥락이 있을 때만 "참고용" 표시와 함께), 최근 요약, 기분 이유, `strongHints`가 있으면 "강한 후보" 문구, 기준 문장 "기본값은 0개"가 들어 있음
  - `recentSummaries`가 비면 그 단락 없음
  - `parseRecordOutput`: `{ experiences: [] }` → `[]`; 4개 → 앞 유효 3개; `importance: 2.5`·`0`·`"3"` 항목 버림; 빈 `summary` 버림; 150자 summary → 120자(Review Focus 2); `null`·`{}`·`{ experiences: "x" }` → `undefined`
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-memory-recordPrompt.test.ts` Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 기록 프롬프트와 출력 해석"`

---

### Task 8: 기록기

**Files:**
- Create: `src/persona/memory/recorder.ts`
- Test: `test/persona-memory-recorder.test.ts`

**Interfaces:**
- Consumes: Task 3~7 전부, `oneShot.ts`의 `runStructuredQuery`·`OneShotQueryError`·`OneShotQueryFn`·`OneShotResult`
- Produces:
  ```ts
  export type RecordModel = (prompt: string) => Promise<OneShotResult>;
  /** Global Constraints의 Haiku 옵션으로 queryFn을 감싼다. 60초가 지나면 abort. */
  export function createRecordModel(queryFn: OneShotQueryFn, env: Record<string, string | undefined>): RecordModel;
  export interface MemoryRecorderDeps {
    profile: PersonaProfile;
    initialFile: MemoryFile;
    readMessages: (sessionId: string, cwd: string) => Promise<SessionMessage[]>;
    model: RecordModel;
    save: (file: MemoryFile) => Promise<MemoryFile>;
    moodContext: () => { reasons: readonly MoodReason[]; markers: readonly MoodMarker[] };
    clock: () => Date;
    onCost: (usd: number) => void;
    onWarning: (message: string) => void;
    onChange: (file: MemoryFile) => void;
  }
  export interface MemoryRecorder {
    /** 처음 보는 세션이면 cursor null·recordedUntil=지금으로 추가, 아는 세션이면 lastSeenAt만 갱신. 저장은 다음 기록 때. */
    register(sessionId: string, cwd: string): void;
    /** 그 세션 기록을 대기열에 넣고 끝나면 resolve. 절대 reject하지 않는다. 등록 안 된 세션은 즉시 resolve. */
    request(sessionId: string): Promise<void>;
    /** trimSessions 후 남은 세션을 차례로 request. */
    catchUp(): Promise<void>;
    current(): MemoryFile;
  }
  export function createMemoryRecorder(deps: MemoryRecorderDeps): MemoryRecorder;
  ```
  기록 한 번(spec 4.2): `readMessages` → `lastReadAt` 갱신 → `buildSegment` → `undefined`이거나 `userInputs === 0`이면 커서만 그대로 두고 끝 → `summarizeSegmentMood(reasons, markers, recordedUntil, now)` → `buildRecordPrompt`(최근 요약 20개) → `model` → `parseRecordOutput` → 경험 추가(`id = <now ISO>-<순번>`, `at = now`, `sessionId`, mood 요약) → `pruneExperiences` → 커서 `lastUuid`, `failures 0`, `recordedUntil = now` → `save` → `onChange(합친 결과)`.
  - 비용: 성공 `costUsd`, 실패 `OneShotQueryError.costUsd`를 `onCost`로.
  - 모델 실패·`parseRecordOutput` `undefined` → `failures` +1. `RECORD_MAX_FAILURES`에 닿으면 커서를 `lastUuid`로 넘기고 `failures 0`. 이 변화도 저장한다.
  - `readMessages` 실패 → 아무것도 바꾸지 않음. `save` 실패 → 메모리 상태를 저장 전으로 되돌림(Review Focus 4).
  - 경고: 위 실패들 중 첫 번째만 `onWarning("인격 기억을 기록하지 못했습니다: <원인>")`.
  - 대기열: 전체에서 한 번에 하나. 같은 세션 요청이 이미 대기 중이면 그 Promise를 돌려준다. 실행 중인 세션에 새 요청이 오면 끝난 뒤 한 번 더 돈다(Review Focus 3).

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 `readMessages`·`model`·`save`(메모리 배열에 기록)·고정 `clock`으로:
  - 등록 후 `request` → 모델 1회, 경험 추가, 커서 이동, `save`·`onChange` 호출
  - 모델이 0개 → 경험 없음, 커서는 이동
  - 사용자 입력 없는 구간 → 모델 호출 없음, 커서 그대로
  - 모델 실패 → 커서 그대로, `failures` 1; 3번 연속 → 커서 넘김; 경고는 한 번만
  - `parseRecordOutput`이 `undefined`인 출력 → 실패로 셈
  - `OneShotQueryError(costUsd 0.01)` → `onCost(0.01)`
  - `save` reject → 커서·경험이 저장 전 상태, 다음 `request`에서 같은 구간 다시(Review Focus 4)
  - 실행 중에 같은 세션 두 번 요청 → 모델 호출이 겹치지 않고 총 2회, 두 번째는 첫 번째의 새 커서 뒤부터(Review Focus 3); 대기 중 두 번 요청 → 1회로 합쳐짐
  - 등록 안 된 세션 `request` → 즉시 resolve, 호출 없음
  - `catchUp` → 저장된 `cwd`로 `readMessages` 호출(Review Focus 5), 31일 지난 세션은 읽지 않고 목록에서 빠짐
  - 프롬프트에 `moodContext`의 범위 안 이유와 표시점이 들어감
  - `createRecordModel`: 가짜 `queryFn`이 받은 `options`에 `model: "claude-haiku-5-5"`, `tools: []`, `settingSources: []`, `persistSession: false`, `maxTurns: 3`, `maxBudgetUsd: 0.05`, `outputFormat.type === "json_schema"`
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-memory-recorder.test.ts` Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 기억 기록기"`

---

### Task 9: 프롬프트에 기억 넣기

**Files:**
- Modify: `src/persona/prompt.ts`
- Test: `test/persona-prompt.test.ts`

**Interfaces:**
- Consumes: Task 4의 `StartupMemories`, `Experience`
- Produces:
  - `buildSystemAppend(profile: PersonaProfile, startup?: StartupMemories): string` — `startup`이 없거나 `memories`가 비면 지금과 같은 문자열.
  - `TurnReport`에 `recalled: { experience: Experience; strong: boolean }[]` 추가(기존 호출부는 `[]`).
  - 날짜 표기 `formatMemoryDate(at: string): string` — 로컬 시각 기준 `M/D`(앞 0 없음).
  - 정확한 문구:
    - 단락 머리: `## 기억`, 다음 줄 `사용자와 함께한 일 중 기억나는 것. 대화에 자연스러울 때만 꺼내고, 억지로 언급하지 않는다.`
    - 항목: `- <M/D> <summary> (<feeling>)`
    - lead: `- 첫 대화에서 이 일을 먼저 언급해도 된다(한 번만): <M/D> <summary>`
    - 회상: `떠오른 기억: <M/D> <summary>`, strong이면 바로 다음 줄 `강하게 떠오름 — 하던 얘기를 멈추고 먼저 꺼내도 된다.`

- [ ] **Step 1: 실패하는 테스트 작성**
  - 기억 없음 → 기존 스냅숏(또는 기존 기대 문자열)과 동일
  - 기억 2개 → 단락과 항목 형식; lead 있으면 lead 줄
  - `formatMemoryDate("2026-11-19T06:41:00.000Z")`가 `TZ`에 따라 바뀜을 고려해, 테스트는 로컬 시각으로 만든 `new Date(2026, 10, 19, 15, 41).toISOString()` → `"11/19"`
  - `buildTurnContext`: `recalled` 비면 줄 없음; 하나 → `떠오른 기억:` 줄; strong → 다음 줄 문구
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-prompt.test.ts` Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 시스템 append와 상태 블록에 기억"`

---

### Task 10: 런타임 연결

**Files:**
- Modify: `src/persona/runtime.ts`
- Test: `test/persona-runtime.test.ts`

**Interfaces:**
- Consumes: Task 4(`recallMemories`, `recallEvent`, `MoodMarker`, `StartupMemories`), Task 8(`MemoryRecorder`), Task 9(`buildSystemAppend`, `TurnReport.recalled`)
- Produces:
  ```ts
  export interface PersonaMemoryDeps {
    recorder: MemoryRecorder;
    startup: StartupMemories;
    /** 회상 대상(세션 중 새로 기록된 것 포함) */ experiences: () => readonly Experience[];
  }
  // PersonaRuntimeDeps에 memory?: PersonaMemoryDeps 추가
  // PersonaRuntime에 moodContext(): { reasons: readonly MoodReason[]; markers: readonly MoodMarker[] } 추가
  // hooks에 PreCompact, SessionEnd 추가(memory가 있을 때만)
  ```
  - 훅 입력의 `session_id`·`cwd`로 처음 보는 세션이면 `recorder.register`.
  - `Stop`: 기존처럼 `turnStartedAt`이 있을 때만(사용자 턴) 그 세션 턴 수 +1, `RECORD_EVERY_TURNS`에 닿으면 `void recorder.request(id)` 후 0.
  - `PreCompact`: `PRECOMPACT_WAIT_MS > 0`이면 `Promise.race([recorder.request(id), 대기 시간])`, 0이면 `void recorder.request(id)`. 그 세션 턴 수 0.
  - `SessionEnd`: `void recorder.request(id)`.
  - 기록기 호출은 기분 대기열(`serialize`) 밖에서 한다. `PreCompact`·`SessionEnd`는 기분 대기열을 거치지 않는 별도 콜백이며, 훅 `timeout`은 `PRECOMPACT_WAIT_MS / 1000 + 5`초.
  - `UserPromptSubmit`(사용자 입력일 때): 사용자 턴 번호 +1 → `recallMemories({ prompt, experiences: experiences(), excludeIds: startup 기억 id들, lastRecalledTurn, turn })` → 떠올린 것마다 `lastRecalledTurn` 기록, `recallEvent`를 `apply` → `TurnReport.recalled`에 담는다. 중요도 3의 `strong`은 세션(런타임)당 처음 한 번만 `true`.
  - 표시점: `onPrompt`·`onEvents`에서 상태가 바뀔 때 `readMood`의 세기가 `extreme`으로 들어가거나 나오면 `{ at, text: "극단 진입: <방향 라벨>" | "극단 탈출" }`, `signFlips`마다 `{ at, text: "<축> 부호 전환" }`을 최근 `MOOD_MARKERS`개 보관.
  - `systemAppend`는 `buildSystemAppend(profile, memory?.startup)`.

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 `MemoryRecorder`(호출 기록)로:
  - `memory` 없으면 `hooks` 키가 지금과 같고(`PreCompact`·`SessionEnd` 없음) `systemAppend`도 같음
  - 처음 보는 `session_id` → `register(id, cwd)` 한 번, 같은 id 두 번째는 없음
  - 사용자 턴 10번(`UserPromptSubmit` → `Stop`) → `request` 1회; `UserPromptSubmit` 없이 온 `Stop`은 세지 않음
  - `PreCompact` → `request` 호출, 대기 설정이면 기록이 오래 걸려도 대기 시간 뒤 훅이 끝남(가짜 타이머)
  - `SessionEnd` → `request` 호출, 기다리지 않음
  - 회상: 관련 입력 → 상태 블록에 `떠오른 기억:`, 기분이 `recallEvent`만큼 변하고 이유에 `기억:`; source가 사용자 입력이 아니면 회상 없음; 같은 기억은 10턴 안에 다시 안 나옴; strong 문구는 한 번만
  - 기록기 `request`가 영원히 안 끝나도 `UserPromptSubmit` 훅은 끝남
  - `moodContext()`: 극단 진입·탈출, 부호 전환 표시점이 쌓이고 20개를 넘지 않음
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-runtime.test.ts` Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` Expected: 모두 통과
- [ ] **Step 5: Commit** — `git commit -m "feat(persona): 런타임에 기억 기록·회상 연결"`

---

### Task 11: 시작 조립, 따라잡기, 문서

**Files:**
- Modify: `src/persona/bootstrap.ts`, `src/main.ts`, `CLAUDE.md`, `README.md`, `docs/suberpowers/plans/2026-11-19-persona-memory.md`(체크박스)
- Test: `test/persona-bootstrap.test.ts`

**Interfaces:**
- Consumes: Task 5(`loadMemories`, `saveMemories`), Task 4(`selectStartupMemories`), Task 8(`createMemoryRecorder`, `createRecordModel`), Task 10(`PersonaMemoryDeps`, `runtime.moodContext`)
- Produces:
  - `OpenPersonaDeps`에 `readMessages?: (sessionId: string, cwd: string) => Promise<SessionMessage[]>` 추가(기본값 `(id, cwd) => getSessionMessages(id, { dir: cwd })`).
  - `openPersona`: `loadMemories`(경고는 `onWarning`) → `selectStartupMemories` → `createMemoryRecorder`(`save: (file) => saveMemories(name, file, dir)`, `model: createRecordModel(deps.queryFn, deps.env)`, `moodContext: () => runtime.moodContext()`, `onChange`로 회상 대상 갱신) → 런타임 → `void recorder.catchUp()`.
  - `main.ts`는 바꿀 것이 없으면 그대로 둔다(`openPersona`의 기존 deps로 충분). 필요하면 `readMessages`만 넘긴다.

- [ ] **Step 1: 실패하는 테스트 작성** (임시 디렉터리, 가짜 `queryFn`·`readMessages`)
  - 기억 파일이 없으면 `systemAppend`에 `## 기억`이 없고 런타임 `hooks`에 `PreCompact`가 있음
  - 기억 파일이 있으면 `systemAppend`에 시작용 기억
  - 깨진 기억 파일 → `onWarning("기억 파일이 깨져 새로 시작합니다")`, 열기 성공
  - 따라잡기: 커서 뒤에 사용자 입력이 남은 세션이 있으면 열고 나서 가짜 `queryFn`이 한 번 불리고 파일에 경험과 새 커서가 저장됨; 남은 메시지가 없으면 호출 없음
- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/persona-bootstrap.test.ts` Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 문서**
  - `CLAUDE.md` 구조 표에 `src/persona/memory/*` 다섯 파일 행 추가, `runtime.ts`·`prompt.ts`·`bootstrap.ts`·`store.ts`·`sessionHistory.ts` 행에 바뀐 책임 한 구절씩
  - `README.md` 인격 섹션에 한 단락: 인격은 함께한 일을 `<이름>.memories.json`에 기억하고 다음 대화에서 꺼낸다, 내용은 화면에 보이지 않는다, 기록 한 번에 Haiku 비용이 든다
  - 이 plan의 체크박스 갱신
- [ ] **Step 5: 통과 확인** — Run: `npm test && npm run typecheck && npm run build` Expected: 모두 통과
- [ ] **Step 6: 실제 확인** — `npm run dev -- --persona yuri`로 열어 11턴 이상 대화한 뒤 종료하고, `~/.config/claud3/personas/yuri.memories.json`에 세션 항목과 커서가 생겼는지(경험은 0개일 수 있음) 확인한다. 다시 열었을 때 따라잡기가 남은 구간만 처리하는지 확인한다. 내용은 사용자에게 보여 주지 않고 형식만 확인한다.
- [ ] **Step 7: Commit** — `git commit -m "feat(persona): 기억 시작 조립·따라잡기와 문서"`
