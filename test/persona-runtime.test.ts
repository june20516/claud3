import { readFileSync } from "node:fs";
import type { HookCallback, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ReactionJudge } from "../src/persona/actions.js";
import { initialMood } from "../src/persona/mood.js";
import type { MoodState } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import { createPersonaRuntime } from "../src/persona/runtime.js";
import type { PersonaRuntimeDeps } from "../src/persona/runtime.js";
import type { SignalSources } from "../src/persona/signals.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;
const START = new Date(2026, 10, 4, 10, 0);
const BASE = { session_id: "s", transcript_path: "/tmp/t", cwd: "/tmp" };

function quietSources(now: Date): SignalSources {
  return { now, readMemoryAvailablePercent: async () => 50, loadAverage1m: 0, cpuCount: 8 };
}

function setup(overrides: Partial<PersonaRuntimeDeps> = {}) {
  let now = START;
  const saved: MoodState[] = [];
  const warnings: string[] = [];
  const deps: PersonaRuntimeDeps = {
    profile: PROFILE,
    initialState: initialMood(START),
    saveMood: async (state) => {
      saved.push(state);
    },
    signalSources: quietSources,
    judge: async () => undefined,
    clock: () => now,
    onWarning: (message) => warnings.push(message),
    ...overrides,
  };
  const runtime = createPersonaRuntime(deps);
  const hook = (event: keyof typeof runtime.hooks): HookCallback => {
    const callback = runtime.hooks[event]?.[0]?.hooks[0];
    if (callback === undefined) {
      throw new Error(`hook ${event} 없음`);
    }
    return callback;
  };
  const call = (input: HookInput): Promise<HookJSONOutput> =>
    hook(input.hook_event_name).call(undefined, input, undefined, { signal: new AbortController().signal });
  return {
    runtime,
    saved,
    warnings,
    call,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function prompt(text: string, source?: "user" | "system"): HookInput {
  return { ...BASE, hook_event_name: "UserPromptSubmit", prompt: text, ...(source === undefined ? {} : { source }) };
}

function toolFailure(): HookInput {
  return { ...BASE, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, tool_use_id: "u", error: "x" };
}

function toolSuccess(): HookInput {
  return { ...BASE, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: {}, tool_use_id: "u" };
}

function stop(): HookInput {
  return { ...BASE, hook_event_name: "Stop", stop_hook_active: false };
}

function contextOf(output: HookJSONOutput): string | undefined {
  if ("hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "UserPromptSubmit") {
    return output.hookSpecificOutput.additionalContext;
  }
  return undefined;
}

describe("createPersonaRuntime", () => {
  it("시스템 append에 인격 소개가 들어 있다", () => {
    expect(setup().runtime.systemAppend).toContain("# 인격: 라피");
  });

  it("입력이 들어오면 상태 블록을 주입하고, 저장하고, 구독자에게 알린다", async () => {
    const { runtime, saved, call } = setup();
    const listener = vi.fn();
    runtime.subscribe(listener);
    const output = await call(prompt("안녕"));
    expect(contextOf(output)).toMatch(/^\[라피 상태\]/);
    expect(saved).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().state.lastSessionStartAt).toBe(START.toISOString());
  });

  it("사용자 행동 줄의 반응을 상태와 문구에 반영한다", async () => {
    const { runtime, call } = setup();
    const output = await call(prompt("오늘 수고했어\n(츄르를 준다)"));
    expect(contextOf(output)).toContain("사용자 행동: 츄르를 준다 → stress −20, dopamine +25.");
    expect(runtime.snapshot().state.stress).toBeLessThan(-20);
  });

  it("판단기가 새로 판단한 반응을 기억한다", async () => {
    const judge: ReactionJudge = async ({ action }) => ({ action, stress: -10, dopamine: 10, note: "" });
    const { runtime, call } = setup({ judge });
    await call(prompt("(담요를 덮어준다)"));
    expect(runtime.snapshot().state.learnedReactions).toEqual([{ action: "담요를 덮어준다", stress: -10, dopamine: 10, note: "" }]);
  });

  it("동시에 들어온 도구 실패 3개를 순서대로 모두 반영한다", async () => {
    const { runtime, call } = setup();
    await Promise.all([call(toolFailure()), call(toolFailure()), call(toolFailure())]);
    const { state } = runtime.snapshot();
    expect(state.failureStreak).toBe(3);
    expect(state.stress).toBeCloseTo(4 + 6 + 8);
  });

  it("도구 이벤트는 주입하지 않는다", async () => {
    const { call } = setup();
    expect(await call(toolSuccess())).toEqual({});
  });

  it("턴이 60초를 넘기면 Stop에서 응답 지연을 반영하고 다음 문구의 원인에 넣는다", async () => {
    const { call, advance } = setup();
    await call(prompt("빌드해 줘"));
    advance(61_000);
    await call(stop());
    const output = await call(prompt("다음"));
    expect(contextOf(output)).toContain("응답 지연");
  });

  it("사용자가 아닌 입력(작업 알림 등)은 수치를 바꾸지 않고 상태만 알려 준다", async () => {
    const { runtime, call } = setup();
    await call(prompt("이 멍청한", "system"));
    expect(runtime.snapshot().state.stress).toBe(0);
  });

  it("저장이 실패하면 경고하고 대화는 계속한다", async () => {
    const { call, warnings } = setup({
      saveMood: async () => {
        throw new Error("disk full");
      },
    });
    expect(await call(prompt("안녕"))).toEqual({});
    expect(warnings).toEqual(["인격 처리 중 오류: disk full"]);
  });

  it("구독을 해제하면 더 알리지 않는다", async () => {
    const { runtime, call } = setup();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    unsubscribe();
    await call(prompt("안녕"));
    expect(listener).not.toHaveBeenCalled();
  });
});
