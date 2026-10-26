import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { describePermissionMode } from "../src/permissionModes.js";
import { CREDIT_HINT, HISTORY_HEADER } from "../src/ui/plain.js";
import {
  addNotice,
  addUserInput,
  commitStreaming,
  initialTranscript,
  reduceTranscript,
  startTurn,
  type TranscriptState,
} from "../src/ui/ink/transcript.js";
import type { UiEvent } from "../src/types.js";

function reduceAll(events: UiEvent[], start: TranscriptState = initialTranscript): TranscriptState {
  return events.reduce(reduceTranscript, start);
}

const toolStart: UiEvent = {
  type: "tool_start",
  toolUseId: "t1",
  name: "Read",
  summary: "a.ts",
  input: { file_path: "a.ts" },
};

describe("addUserInput / addNotice", () => {
  it("사용자 입력을 done에 추가하고 id를 올린다", () => {
    const state = addUserInput(initialTranscript, "안녕");
    expect(state.done).toEqual([{ kind: "user", id: 0, text: "안녕" }]);
    expect(state.nextId).toBe(1);
  });

  it("진행 중 응답이 있으면 먼저 확정한다", () => {
    const state = addUserInput(reduceAll([{ type: "text_delta", text: "답" }]), "다음");
    expect(state.streaming).toBeUndefined();
    expect(state.done.map((item) => item.kind)).toEqual(["assistant", "user"]);
  });

  it("notice를 tone과 함께 추가한다", () => {
    const state = addNotice(initialTranscript, "error", "문제");
    expect(state.done).toEqual([{ kind: "notice", id: 0, tone: "error", text: "문제" }]);
  });

  it("원본 state를 바꾸지 않는다", () => {
    addUserInput(initialTranscript, "x");
    addNotice(initialTranscript, "info", "x");
    expect(initialTranscript.done).toEqual([]);
    expect(initialTranscript.nextId).toBe(0);
  });
});

describe("commitStreaming", () => {
  it("streaming이 없으면 같은 state를 돌려준다", () => {
    expect(commitStreaming(initialTranscript)).toBe(initialTranscript);
  });

  it("아직 끝나지 않은 마지막 줄을 done으로 옮긴다", () => {
    const streaming = reduceAll([{ type: "text_delta", text: "일부" }]);
    const state = commitStreaming(streaming);
    expect(state.streaming).toBeUndefined();
    expect(state.done).toEqual([{ kind: "assistant", id: 0, text: "일부", attached: false }]);
    expect(streaming.streaming).toBeDefined();
  });

  it("남은 조각이 없으면 streaming만 없앤다", () => {
    const state = commitStreaming(reduceAll([{ type: "text_delta", text: "끝\n" }]));
    expect(state.streaming).toBeUndefined();
    expect(state.done).toEqual([{ kind: "assistant", id: 0, text: "끝", attached: false }]);
  });
});

function assistantTexts(state: TranscriptState): string[] {
  return state.done.flatMap((item) => (item.kind === "assistant" ? [stripVTControlCharacters(item.text)] : []));
}

describe("reduceTranscript", () => {
  it("줄바꿈 없는 text_delta는 streaming에 이어 붙인다", () => {
    const state = reduceAll([
      { type: "text_delta", text: "안" },
      { type: "text_delta", text: "녕" },
    ]);
    expect(state.streaming?.pending).toBe("안녕");
    expect(state.done).toEqual([]);
  });

  it("여러 줄 delta의 완성 줄은 바로 done에 넣고 마지막 조각만 streaming에 남긴다", () => {
    const first = reduceAll([{ type: "text_delta", text: "첫 줄\n둘" }]);
    expect(first.done).toEqual([{ kind: "assistant", id: 0, text: "첫 줄", attached: false }]);
    expect(first.streaming?.pending).toBe("둘");

    const second = reduceTranscript(first, { type: "text_delta", text: "째 줄\n셋째\n넷" });
    expect(second.done[1]).toEqual({ kind: "assistant", id: 1, text: "둘째 줄\n셋째", attached: true });
    expect(second.streaming?.pending).toBe("넷");
  });

  it("코드 블록 상태가 delta 사이에 이어진다", () => {
    const state = commitStreaming(
      reduceAll([
        { type: "text_delta", text: "```\n" },
        { type: "text_delta", text: "- a\n```\n" },
        { type: "text_delta", text: "- b" },
      ]),
    );
    expect(assistantTexts(state).join("\n")).toBe("```\n- a\n```\n• b");
  });

  it("빈 줄은 다음 내용이 올 때까지 미뤄 응답 끝에 빈 줄을 남기지 않는다", () => {
    const trailing = commitStreaming(reduceAll([{ type: "text_delta", text: "a\n\n" }]));
    expect(assistantTexts(trailing)).toEqual(["a"]);

    const between = commitStreaming(
      reduceAll([
        { type: "text_delta", text: "a\n\n" },
        { type: "text_delta", text: "b" },
      ]),
    );
    expect(assistantTexts(between)).toEqual(["a", "\nb"]);
  });

  it("text_delta 외 이벤트는 streaming을 확정한다", () => {
    const state = reduceAll([{ type: "text_delta", text: "응답" }, toolStart]);
    expect(state.streaming).toBeUndefined();
    expect(state.done[0]).toEqual({ kind: "assistant", id: 0, text: "응답", attached: false });
    expect(state.running).toHaveLength(1);
  });

  it("tool_start는 도구 줄(입력 포함)을 바로 done에 넣고 running에는 실행 중 표시만 둔다", () => {
    const state = reduceAll([toolStart]);
    expect(state.done).toEqual([
      { kind: "tool", id: 0, name: "Read", summary: "a.ts", input: { file_path: "a.ts" } },
    ]);
    expect(state.running).toEqual([{ toolUseId: "t1", name: "Read", summary: "a.ts" }]);
  });

  it("정상으로 끝난 도구는 실행 중 표시만 없앤다", () => {
    const state = reduceAll([toolStart, { type: "tool_end", toolUseId: "t1", isError: false, summary: "ok" }]);
    expect(state.running).toEqual([]);
    expect(state.done).toHaveLength(1);
  });

  it("오류로 끝난 도구는 도구 줄에 붙는 오류 notice를 넣는다", () => {
    const state = reduceAll([toolStart, { type: "tool_end", toolUseId: "t1", isError: true, summary: "없음" }]);
    expect(state.running).toEqual([]);
    expect(state.done[1]).toEqual({ kind: "notice", id: 1, tone: "error", text: "  ⎿ 없음", attached: true });
  });

  it("알 수 없는 toolUseId의 tool_end는 무시한다", () => {
    const state = reduceAll([toolStart, { type: "tool_end", toolUseId: "zz", isError: true, summary: "" }]);
    expect(state.running).toHaveLength(1);
    expect(state.done).toHaveLength(1);
  });

  it("병렬 도구는 끝난 것만 실행 중 표시를 없앤다", () => {
    const state = reduceAll([
      toolStart,
      { ...toolStart, toolUseId: "t2" },
      { type: "tool_end", toolUseId: "t2", isError: false, summary: "" },
    ]);
    expect(state.running.map((tool) => tool.toolUseId)).toEqual(["t1"]);
    expect(state.done).toHaveLength(2);
  });

  it("turn_result는 누적 비용을 갱신하고 비용 dim notice를 넣는다", () => {
    const state = reduceAll([{ type: "turn_result", costUsd: 0.0123, totalCostUsd: 0.5, isError: false }]);
    expect(state.sessionCostUsd).toBe(0.5);
    expect(state.done).toEqual([{ kind: "notice", id: 0, tone: "dim", text: "── $0.0123 · 누적 $0.5000" }]);
  });

  it("오류 turn_result는 error notice를 비용 notice 앞에 넣는다", () => {
    const state = reduceAll([
      { type: "turn_result", costUsd: 0, totalCostUsd: 0, isError: true, errorMessage: "boom" },
    ]);
    expect(state.done.map((item) => (item.kind === "notice" ? [item.tone, item.text] : item.kind))).toEqual([
      ["error", "boom"],
      ["dim", "── $0.0000 · 누적 $0.0000"],
    ]);
  });

  it("credit balance 오류면 크레딧 안내를 하나 더 넣는다", () => {
    const state = reduceAll([
      { type: "turn_result", costUsd: 0, totalCostUsd: 0, isError: true, errorMessage: "Credit balance is too low" },
    ]);
    expect(state.done[1]).toMatchObject({ kind: "notice", tone: "error", text: CREDIT_HINT });
    expect(state.done).toHaveLength(3);
  });

  it("session_start는 header와 model을 설정한다", () => {
    const state = reduceAll([{ type: "session_start", sessionId: "s", model: "opus", apiKeySource: "env" }]);
    expect(state.model).toBe("opus");
    expect(state.header).toBe("claud3 · API key(env) · Agent SDK · opus");
  });

  it("permission_mode는 모드를 설정하고 dim notice를 넣는다", () => {
    const state = reduceAll([{ type: "permission_mode", mode: "plan" }]);
    expect(state.permissionMode).toBe("plan");
    expect(state.done).toEqual([
      { kind: "notice", id: 0, tone: "dim", text: `권한 모드: ${describePermissionMode("plan")}` },
    ]);
  });

  it("error는 오류 notice를 넣는다", () => {
    const state = reduceAll([{ type: "error", message: "실패" }]);
    expect(state.done).toEqual([{ kind: "notice", id: 0, tone: "error", text: "오류: 실패" }]);
  });

  it("session_closed는 세션 ID와 누적 비용 info notice를 넣는다", () => {
    const state = reduceAll([{ type: "session_closed", sessionId: "abc", totalCostUsd: 1.5 }]);
    expect(state.done).toEqual([
      {
        kind: "notice",
        id: 0,
        tone: "info",
        text: "세션 ID: abc  (이어서: claud3 --resume abc)\n누적 비용 $1.5000",
      },
    ]);
  });

  it("session_closed에 세션 ID가 없으면 비용만 보인다", () => {
    const state = reduceAll([{ type: "session_closed", totalCostUsd: 0 }]);
    expect(state.done[0]).toMatchObject({ text: "누적 비용 $0.0000" });
  });

  it("원본 state를 바꾸지 않는다", () => {
    const before = reduceAll([toolStart]);
    const snapshot = structuredClone(before);
    reduceTranscript(before, { type: "tool_end", toolUseId: "t1", isError: false, summary: "" });
    reduceTranscript(before, { type: "text_delta", text: "x" });
    expect(before).toEqual(snapshot);
  });
});

describe("history 이벤트", () => {
  it("이전 대화 줄을 history 항목으로 done에 추가한다", () => {
    const state = reduceAll([{ type: "history", lines: ["> 이전 입력", "", "이전 응답"] }]);

    expect(state.done).toEqual([{ kind: "history", id: 0, text: "> 이전 입력\n\n이전 응답" }]);
    expect(state.nextId).toBe(1);
    expect(HISTORY_HEADER).toContain("이전 대화");
  });
});

describe("턴 진행 표시", () => {
  const usage = (inputTokens: number, outputTokens: number): UiEvent => ({ type: "token_usage", inputTokens, outputTokens });

  it("startTurn은 시작 시각을 정하고 토큰을 0으로 둔다", () => {
    const state = startTurn(initialTranscript, 1_000);

    expect(state.turn).toEqual({ startedAt: 1_000, inputTokens: 0, outputTokens: 0 });
  });

  it("이미 진행 중인 턴이면 다시 시작하지 않는다", () => {
    const state = startTurn(startTurn(initialTranscript, 1_000), 5_000);

    expect(state.turn?.startedAt).toBe(1_000);
  });

  it("token_usage는 턴의 토큰을 바꾸고, 진행 중인 응답 줄을 확정하지 않는다", () => {
    const state = reduceAll([{ type: "text_delta", text: "쓰는 중" }, usage(1200, 3)], startTurn(initialTranscript, 0));

    expect(state.turn).toMatchObject({ inputTokens: 1200, outputTokens: 3 });
    expect(state.streaming?.pending).toBe("쓰는 중");
    expect(state.done).toEqual([]);
  });

  it("턴이 없으면 token_usage는 무시한다", () => {
    expect(reduceAll([usage(1, 1)]).turn).toBeUndefined();
  });

  it("turn_result·error·session_closed는 턴을 끝낸다", () => {
    const events: UiEvent[] = [
      { type: "turn_result", costUsd: 0, totalCostUsd: 0, isError: false },
      { type: "error", message: "끊김" },
      { type: "session_closed", totalCostUsd: 0 },
    ];
    for (const event of events) {
      expect(reduceTranscript(startTurn(initialTranscript, 0), event).turn).toBeUndefined();
    }
  });
});
