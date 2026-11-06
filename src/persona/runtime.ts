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
import type { PersonaProfile } from "./profile.js";
import { buildSystemAppend, buildTurnContext } from "./prompt.js";
import { signalEvents } from "./signals.js";
import type { SignalSources } from "./signals.js";
import { normalizePrompt, promptEvents, toolEvents, turnDurationEvents } from "./turnEvents.js";

/** 반응 판단(최대 10초)과 sysctl을 기다릴 수 있도록 넉넉히 둔다. */
const HOOK_TIMEOUT_SECONDS = 30;
/** 사용자가 직접 보낸 입력의 source. 작업 알림 같은 기계 입력은 수치를 바꾸지 않는다. */
const USER_SOURCES = new Set([undefined, "user", "sdk"]);

export interface PersonaSnapshot {
  profile: PersonaProfile;
  state: MoodState;
  reading: MoodReading;
}

export interface PersonaRuntimeDeps {
  profile: PersonaProfile;
  initialState: MoodState;
  saveMood: (state: MoodState) => Promise<void>;
  signalSources: (now: Date) => SignalSources;
  judge: ReactionJudge;
  clock: () => Date;
  onWarning: (message: string) => void;
}

export interface PersonaRuntime {
  readonly systemAppend: string;
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  snapshot(): PersonaSnapshot;
  subscribe(listener: (snapshot: PersonaSnapshot) => void): () => void;
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

  const snapshot = (): PersonaSnapshot => ({ profile, state, reading: readMood(state.stress, state.dopamine) });

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function apply(events: MoodEvent[], now: Date): void {
    for (const event of events) {
      const next = applyEvent(state, event, profile, now);
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
    if (isUserPrompt) {
      apply(signals, now);
      apply(promptEvents(prompt, state.recentPrompts), now);
      state = rememberPrompt(state, normalizePrompt(prompt));
      const resolved = await resolveReactions(extractActionLines(prompt), profile, state, deps.judge);
      apply(resolved.events, now);
      state = { ...state, learnedReactions: [...state.learnedReactions, ...resolved.learned] };
      actions = resolved.events.flatMap((event) => (event.kind === "userAction" ? [event] : []));
      state = advanceExtremeTurns(state);
    }
    await commit();

    const additionalContext = buildTurnContext(profile, {
      state,
      reading: readMood(state.stress, state.dopamine),
      reasons: pendingReasons,
      flips: signFlips(before, state),
      actions,
      now,
    });
    pendingReasons = [];
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
  }

  async function onEvents(events: MoodEvent[]): Promise<HookJSONOutput> {
    const now = deps.clock();
    // 긴 턴 동안 흐른 시간도 감쇠에 넣는다.
    state = decay(state, now);
    apply(events, now);
    await commit();
    return {};
  }

  async function onStop(): Promise<HookJSONOutput> {
    if (turnStartedAt === undefined) {
      return {};
    }
    const durationMs = deps.clock().getTime() - turnStartedAt;
    turnStartedAt = undefined;
    return onEvents(turnDurationEvents(durationMs));
  }

  function handle(input: HookInput): Promise<HookJSONOutput> {
    switch (input.hook_event_name) {
      case "UserPromptSubmit":
        return onPrompt(input.prompt, USER_SOURCES.has(input.source));
      case "PostToolUse":
      case "PostToolUseFailure":
        return onEvents(toolEvents(input));
      case "Stop":
        return onStop();
      default:
        return Promise.resolve({});
    }
  }

  const callback: HookCallback = (input) =>
    serialize(() => handle(input)).catch((error: unknown) => {
      deps.onWarning(`인격 처리 중 오류: ${errorText(error)}`);
      return {};
    });
  const matcher: HookCallbackMatcher[] = [{ hooks: [callback], timeout: HOOK_TIMEOUT_SECONDS }];

  return {
    systemAppend: buildSystemAppend(profile),
    hooks: { UserPromptSubmit: matcher, PostToolUse: matcher, PostToolUseFailure: matcher, Stop: matcher },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
