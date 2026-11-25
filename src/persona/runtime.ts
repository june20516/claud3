import type { HookCallback, HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { extractActionLines, resolveReactions } from "./actions.js";
import type { ReactionJudge } from "./actions.js";
import {
  advanceExtremeTurns,
  applyEvent,
  decay,
  readMood,
  rememberPrompt,
  signFlips,
} from "./mood.js";
import type { MoodEvent, MoodReading, MoodReason, MoodState } from "./mood.js";
import { recallEvent, recallMemories } from "./memory/experience.js";
import type { Experience, MoodMarker, StartupMemories } from "./memory/experience.js";
import type { MemoryRecorder } from "./memory/recorder.js";
import type { PersonaProfile } from "./profile.js";
import { buildSystemAppend, buildTurnContext, DIRECTION_LABELS } from "./prompt.js";
import type { TurnReport } from "./prompt.js";
import { signalEvents } from "./signals.js";
import type { SignalSources } from "./signals.js";
import { MOOD_MARKERS, PRECOMPACT_WAIT_MS, RECORD_EVERY_TURNS } from "./tuning.js";
import { normalizePrompt, promptEvents, toolEvents, turnDurationEvents } from "./turnEvents.js";

/** 반응 판단(최대 10초)과 sysctl을 기다릴 수 있도록 넉넉히 둔다. */
const HOOK_TIMEOUT_SECONDS = 30;
/** PreCompact 대기 시간 위에 더하는 훅 시간 제한 여유. */
const HOOK_MARGIN_SECONDS = 5;
/** 사용자가 직접 보낸 입력의 source. 작업 알림 같은 기계 입력은 수치를 바꾸지 않는다. */
const USER_SOURCES = new Set([undefined, "user", "sdk"]);

export interface PersonaSnapshot {
  profile: PersonaProfile;
  state: MoodState;
  reading: MoodReading;
}

export interface PersonaMemoryDeps {
  recorder: MemoryRecorder;
  startup: StartupMemories;
  /** 회상 대상. 세션 중 새로 기록된 경험도 들어 있다. */
  experiences: () => readonly Experience[];
}

export interface PersonaRuntimeDeps {
  profile: PersonaProfile;
  initialState: MoodState;
  saveMood: (state: MoodState) => Promise<void>;
  signalSources: (now: Date) => SignalSources;
  judge: ReactionJudge;
  clock: () => Date;
  onWarning: (message: string) => void;
  /** 없으면 기억 기능을 쓰지 않는다(훅·append가 지금과 같다). */
  memory?: PersonaMemoryDeps;
}

export interface PersonaRuntime {
  readonly systemAppend: string;
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  snapshot(): PersonaSnapshot;
  subscribe(listener: (snapshot: PersonaSnapshot) => void): () => void;
  /** 기록기가 구간 시간대의 기분을 요약할 때 쓴다. */
  moodContext(): { reasons: readonly MoodReason[]; markers: readonly MoodMarker[] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 기분 상태를 들고 SDK hook을 처리한다. 모든 갱신은 한 줄로 세워(직렬화) 병렬 도구 hook이 서로 덮어쓰지 않게 한다.
 * hook 안의 예외는 경고만 하고 삼켜서, 인격 기능 때문에 대화가 멈추지 않게 한다.
 */
export function createPersonaRuntime(deps: PersonaRuntimeDeps): PersonaRuntime {
  const { profile } = deps;
  const listeners = new Set<(snapshot: PersonaSnapshot) => void>();
  let state = deps.initialState;
  let queue: Promise<unknown> = Promise.resolve();
  let sessionStarted = false;
  let turnStartedAt: number | undefined;
  /** 직전 상태 블록 이후 쌓인 변동 이유. */
  let pendingReasons: MoodReason[] = [];
  const { memory } = deps;
  /** 극단 진입·탈출, 부호 전환 시점. 기록기의 "강한 후보"가 된다. */
  let markers: MoodMarker[] = [];
  const registeredSessions = new Set<string>();
  const turnsSinceRecord = new Map<string, number>();
  const startupIds = new Set(memory?.startup.memories.map((item) => item.id) ?? []);
  const lastRecalledTurn = new Map<string, number>();
  let userTurn = 0;
  let strongRecallUsed = false;

  const snapshot = (): PersonaSnapshot => ({ profile, state, reading: readMood(state.stress, state.dopamine) });

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function mark(before: MoodState, after: MoodState, now: Date): void {
    const at = now.toISOString();
    const was = readMood(before.stress, before.dopamine);
    const is = readMood(after.stress, after.dopamine);
    const added: MoodMarker[] = [];
    if (is.intensity === "extreme" && was.intensity !== "extreme" && is.direction !== null) {
      added.push({ at, text: `극단 진입: ${DIRECTION_LABELS[is.direction]}` });
    } else if (was.intensity === "extreme" && is.intensity !== "extreme") {
      added.push({ at, text: "극단 탈출" });
    }
    for (const flip of signFlips(before, after)) {
      added.push({ at, text: `${flip.axis} 부호 전환` });
    }
    if (added.length > 0) {
      markers = [...markers, ...added].slice(-MOOD_MARKERS);
    }
  }

  function apply(events: MoodEvent[], now: Date): void {
    for (const event of events) {
      const next = applyEvent(state, event, profile, now);
      mark(state, next, now);
      // 도구 성공은 너무 잦아 실제 원인을 밀어내므로 상태 블록의 원인에는 넣지 않는다.
      if (next.recentReasons !== state.recentReasons && event.kind !== "toolSuccess") {
        const added = next.recentReasons.at(-1);
        if (added !== undefined) {
          pendingReasons.push(added);
        }
      }
      state = next;
    }
  }

  async function commit(): Promise<void> {
    await deps.saveMood(state);
    const current = snapshot();
    for (const listener of listeners) {
      listener(current);
    }
  }

  async function onPrompt(prompt: string, isUserPrompt: boolean): Promise<HookJSONOutput> {
    const now = deps.clock();
    const isFirstPrompt = !sessionStarted;
    sessionStarted = true;
    turnStartedAt = now.getTime();

    const signals = isUserPrompt ? await signalEvents(state, profile, deps.signalSources(now), isFirstPrompt) : [];
    state = decay(state, now);
    if (isFirstPrompt) {
      state = { ...state, lastSessionStartAt: now.toISOString() };
    }
    const before = { stress: state.stress, dopamine: state.dopamine };
    let actions: { action: string; stress: number; dopamine: number }[] = [];
    let recalled: TurnReport["recalled"] = [];
    if (isUserPrompt) {
      apply(signals, now);
      apply(promptEvents(prompt, state.recentPrompts), now);
      state = rememberPrompt(state, normalizePrompt(prompt));
      const resolved = await resolveReactions(extractActionLines(prompt), profile, state, deps.judge);
      apply(resolved.events, now);
      state = { ...state, learnedReactions: [...state.learnedReactions, ...resolved.learned] };
      actions = resolved.events.flatMap((event) => (event.kind === "userAction" ? [event] : []));
      recalled = recall(prompt, now);
      state = advanceExtremeTurns(state);
    }
    await commit();

    const additionalContext = buildTurnContext(profile, {
      state,
      reading: readMood(state.stress, state.dopamine),
      reasons: pendingReasons,
      flips: signFlips(before, state),
      actions,
      recalled,
      now,
    });
    pendingReasons = [];
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
  }

  /** 사용자 입력으로 떠오른 기억을 고르고 회상 이벤트를 적용한다. 강하게 떠오름은 런타임당 한 번. */
  function recall(prompt: string, now: Date): TurnReport["recalled"] {
    if (memory === undefined) {
      return [];
    }
    userTurn++;
    const picked = recallMemories({
      prompt,
      experiences: memory.experiences(),
      excludeIds: startupIds,
      lastRecalledTurn,
      turn: userTurn,
    });
    return picked.map((experience) => {
      lastRecalledTurn.set(experience.id, userTurn);
      const event = recallEvent(experience);
      if (event !== undefined) {
        apply([event], now);
      }
      const strong = experience.importance === 3 && !strongRecallUsed;
      strongRecallUsed ||= strong;
      return { experience, strong };
    });
  }

  async function onEvents(events: MoodEvent[]): Promise<HookJSONOutput> {
    const now = deps.clock();
    // 긴 턴 동안 흐른 시간도 감쇠에 넣는다.
    state = decay(state, now);
    apply(events, now);
    await commit();
    return {};
  }

  async function onStop(sessionId: string): Promise<HookJSONOutput> {
    if (turnStartedAt === undefined) {
      return {};
    }
    countTurn(sessionId);
    const durationMs = deps.clock().getTime() - turnStartedAt;
    turnStartedAt = undefined;
    return onEvents(turnDurationEvents(durationMs));
  }

  /** 사용자 턴을 세고 RECORD_EVERY_TURNS마다 기록을 요청한다. 기록은 기다리지 않는다. */
  function countTurn(sessionId: string): void {
    if (memory === undefined) {
      return;
    }
    const turns = (turnsSinceRecord.get(sessionId) ?? 0) + 1;
    if (turns >= RECORD_EVERY_TURNS) {
      turnsSinceRecord.set(sessionId, 0);
      void memory.recorder.request(sessionId);
      return;
    }
    turnsSinceRecord.set(sessionId, turns);
  }

  function register(input: HookInput): void {
    if (memory !== undefined && !registeredSessions.has(input.session_id)) {
      registeredSessions.add(input.session_id);
      memory.recorder.register(input.session_id, input.cwd);
    }
  }

  /** 압축 후에는 원문을 읽을 수 없어 PreCompact는 기록을 PRECOMPACT_WAIT_MS까지 기다린다. SessionEnd는 기다리지 않는다. */
  async function onMemoryHook(input: HookInput): Promise<HookJSONOutput> {
    if (memory === undefined) {
      return {};
    }
    const sessionId = input.session_id;
    turnsSinceRecord.set(sessionId, 0);
    const isPreCompact = input.hook_event_name === "PreCompact";
    // 압축 직전에는 따라잡기 등 기다리던 기록보다 먼저 돌아야 압축 전 원문을 읽을 수 있다.
    const recording = isPreCompact
      ? memory.recorder.request(sessionId, { urgent: true })
      : memory.recorder.request(sessionId);
    if (isPreCompact) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PRECOMPACT_WAIT_MS);
      });
      await Promise.race([recording, timeout]);
      clearTimeout(timer);
    }
    return {};
  }

  function handle(input: HookInput): Promise<HookJSONOutput> {
    switch (input.hook_event_name) {
      case "UserPromptSubmit":
        return onPrompt(input.prompt, USER_SOURCES.has(input.source));
      case "PostToolUse":
      case "PostToolUseFailure":
        return onEvents(toolEvents(input));
      case "Stop":
        return onStop(input.session_id);
      default:
        return Promise.resolve({});
    }
  }

  const warnOnError = (error: unknown): HookJSONOutput => {
    deps.onWarning(`인격 처리 중 오류: ${errorText(error)}`);
    return {};
  };
  const callback: HookCallback = (input) => {
    register(input);
    return serialize(() => handle(input)).catch(warnOnError);
  };
  const matcher: HookCallbackMatcher[] = [{ hooks: [callback], timeout: HOOK_TIMEOUT_SECONDS }];
  // 기록은 기분 갱신 대기열 밖에서 돈다. 기록이 느려도 대화와 기분 처리를 막지 않는다.
  const memoryCallback: HookCallback = (input) => {
    register(input);
    return onMemoryHook(input).catch(warnOnError);
  };
  const memoryMatcher: HookCallbackMatcher[] = [
    { hooks: [memoryCallback], timeout: PRECOMPACT_WAIT_MS / 1000 + HOOK_MARGIN_SECONDS },
  ];
  const baseHooks = { UserPromptSubmit: matcher, PostToolUse: matcher, PostToolUseFailure: matcher, Stop: matcher };

  return {
    systemAppend: buildSystemAppend(profile, memory?.startup),
    hooks: memory === undefined ? baseHooks : { ...baseHooks, PreCompact: memoryMatcher, SessionEnd: memoryMatcher },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    moodContext: () => ({ reasons: state.recentReasons, markers }),
  };
}
