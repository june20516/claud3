import { readFileSync } from "node:fs";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactionJudge, extractActionLines, resolveReactions } from "../src/persona/actions.js";
import type { ReactionJudge } from "../src/persona/actions.js";
import { initialMood } from "../src/persona/mood.js";
import { OneShotQueryError, runStructuredQuery } from "../src/persona/oneShot.js";
import type { OneShotQueryFn } from "../src/persona/oneShot.js";
import type { PersonaProfile } from "../src/persona/profile.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;
const STATE = initialMood(new Date(2026, 10, 4, 10, 0));

function message(partial: Record<string, unknown>): SDKMessage {
  return { uuid: "u", session_id: "s1", ...partial } as unknown as SDKMessage;
}

function fakeQuery(messages: SDKMessage[]): { queryFn: OneShotQueryFn; calls: { prompt: string; options: Options }[] } {
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: OneShotQueryFn = (params) => {
    calls.push(params);
    return (async function* () {
      yield* messages;
    })();
  };
  return { queryFn, calls };
}

function successResult(output: unknown, cost = 0.01): SDKMessage {
  return message({ type: "result", subtype: "success", structured_output: output, total_cost_usd: cost });
}

describe("extractActionLines", () => {
  it("줄 전체가 괄호인 줄의 안쪽 문장만 뽑는다", () => {
    expect(extractActionLines("안녕\n(츄르를 준다)\n문장 (괄호) 끝")).toEqual(["츄르를 준다"]);
  });

  it("코드 블록 안의 괄호 줄은 행동이 아니고, 밖의 (foo())는 행동이다", () => {
    expect(extractActionLines("```\n(foo())\n```")).toEqual([]);
    expect(extractActionLines("(foo())")).toEqual(["foo()"]);
  });
});

describe("resolveReactions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const neverCalled: ReactionJudge = async () => {
    throw new Error("judge should not be called");
  };

  it("인격의 반응 키워드가 들어 있으면 그 값을 쓰고 판단기를 부르지 않는다", async () => {
    const result = await resolveReactions(["츄르를 준다"], PROFILE, STATE, neverCalled);
    expect(result).toEqual({
      events: [{ kind: "userAction", action: "츄르를 준다", stress: -20, dopamine: 25 }],
      learned: [],
    });
  });

  it("기억한 반응이 있으면 판단기를 부르지 않는다", async () => {
    const state = { ...STATE, learnedReactions: [{ action: "냉각수를 넣는다", stress: -30, dopamine: 5, note: "" }] };
    const result = await resolveReactions(["냉각수를 넣는다"], PROFILE, state, neverCalled);
    expect(result.events).toEqual([{ kind: "userAction", action: "냉각수를 넣는다", stress: -30, dopamine: 5 }]);
  });

  it("모르는 행동은 판단기에 묻고 기억에 남긴다", async () => {
    const judge = vi.fn<ReactionJudge>(async ({ action }) => ({ action, stress: -10, dopamine: 20, note: "따뜻함" }));
    const result = await resolveReactions(["담요를 덮어준다"], PROFILE, STATE, judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.learned).toEqual([{ action: "담요를 덮어준다", stress: -10, dopamine: 20, note: "따뜻함" }]);
    expect(result.events).toEqual([{ kind: "userAction", action: "담요를 덮어준다", stress: -10, dopamine: 20 }]);
  });

  it("판단기가 10초 안에 답하지 않으면 효과 0, 기억하지 않는다", async () => {
    vi.useFakeTimers();
    const hanging: ReactionJudge = () => new Promise(() => {});
    const pending = resolveReactions(["담요를 덮어준다"], PROFILE, STATE, hanging);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({
      events: [{ kind: "userAction", action: "담요를 덮어준다", stress: 0, dopamine: 0 }],
      learned: [],
    });
  });

  it("판단기가 실패해도 효과 0으로 계속한다", async () => {
    const failing: ReactionJudge = async () => {
      throw new Error("boom");
    };
    const result = await resolveReactions(["담요를 덮어준다"], PROFILE, STATE, failing);
    expect(result.events[0]).toMatchObject({ stress: 0, dopamine: 0 });
  });
});

describe("runStructuredQuery", () => {
  it("성공 결과의 structured_output과 비용을 돌려준다", async () => {
    const { queryFn } = fakeQuery([message({ type: "assistant" }), successResult({ a: 1 }, 0.02)]);
    expect(await runStructuredQuery(queryFn, "p", {})).toEqual({ output: { a: 1 }, costUsd: 0.02 });
  });

  it("실패 결과면 subtype과 비용을 담아 던진다", async () => {
    const { queryFn } = fakeQuery([message({ type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.5 })]);
    const error = await runStructuredQuery(queryFn, "p", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OneShotQueryError);
    expect(error).toMatchObject({ subtype: "error_max_budget_usd", costUsd: 0.5 });
  });

  it("결과 메시지 없이 끝나면 던진다", async () => {
    const { queryFn } = fakeQuery([]);
    await expect(runStructuredQuery(queryFn, "p", {})).rejects.toThrow();
  });

  it("onMessage로 모든 메시지를 넘겨 준다", async () => {
    const seen: string[] = [];
    const { queryFn } = fakeQuery([message({ type: "assistant" }), successResult({})]);
    await runStructuredQuery(queryFn, "p", {}, (sdkMessage) => seen.push(sdkMessage.type));
    expect(seen).toEqual(["assistant", "result"]);
  });
});

describe("createReactionJudge", () => {
  it("Haiku·도구 없음·설정 격리·1턴·JSON schema로 묻고, 결과를 ±40 정수로 자른다", async () => {
    const { queryFn, calls } = fakeQuery([successResult({ stress: 70, dopamine: -12.6, note: "시원함" }, 0.001)]);
    const costs: number[] = [];
    const judge = createReactionJudge(queryFn, { ANTHROPIC_API_KEY: "k" }, (usd) => costs.push(usd));
    const result = await judge({ profile: PROFILE, state: STATE, action: "냉각수를 넣는다", signal: new AbortController().signal });

    expect(result).toEqual({ action: "냉각수를 넣는다", stress: 40, dopamine: -13, note: "시원함" });
    expect(costs).toEqual([0.001]);
    const options = calls[0]!.options;
    expect(options).toMatchObject({
      model: "claude-haiku-5-5",
      tools: [],
      settingSources: [],
      maxTurns: 1,
      env: { ANTHROPIC_API_KEY: "k" },
      outputFormat: { type: "json_schema" },
    });
    expect(calls[0]!.prompt).toContain("냉각수를 넣는다");
    expect(calls[0]!.prompt).toContain(PROFILE.summary);
  });

  it("출력 형식이 틀리면 undefined", async () => {
    const { queryFn } = fakeQuery([successResult({ stress: "많이" })]);
    const judge = createReactionJudge(queryFn, {}, () => {});
    expect(await judge({ profile: PROFILE, state: STATE, action: "x", signal: new AbortController().signal })).toBeUndefined();
  });
});
