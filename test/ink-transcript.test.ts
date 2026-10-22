import { describe, expect, it } from "vitest";
import { describePermissionMode } from "../src/permissionModes.js";
import { CREDIT_HINT } from "../src/ui/plain.js";
import {
  addNotice,
  addUserInput,
  commitStreaming,
  initialTranscript,
  reduceTranscript,
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

  it("streaming을 done으로 옮긴다", () => {
    const streaming = reduceAll([{ type: "text_delta", text: "일부" }]);
    const state = commitStreaming(streaming);
    expect(state.streaming).toBeUndefined();
    expect(state.done).toEqual([{ kind: "assistant", id: 0, text: "일부" }]);
    expect(streaming.streaming).toBeDefined();
  });
});

describe("reduceTranscript", () => {
  it("text_delta를 streaming에 이어 붙인다", () => {
    const state = reduceAll([
      { type: "text_delta", text: "안" },
      { type: "text_delta", text: "녕" },
    ]);
    expect(state.streaming).toEqual({ kind: "assistant", id: 0, text: "안녕" });
    expect(state.done).toEqual([]);
  });

  it("text_delta 외 이벤트는 streaming을 확정한다", () => {
    const state = reduceAll([{ type: "text_delta", text: "응답" }, toolStart]);
    expect(state.streaming).toBeUndefined();
    expect(state.done).toEqual([{ kind: "assistant", id: 0, text: "응답" }]);
    expect(state.running).toHaveLength(1);
  });

  it("tool_start는 running에 추가한다", () => {
    const state = reduceAll([toolStart]);
    expect(state.done).toEqual([]);
    expect(state.running).toEqual([
      {
        kind: "tool",
        id: 0,
        toolUseId: "t1",
        name: "Read",
        summary: "a.ts",
        input: { file_path: "a.ts" },
        status: "running",
      },
    ]);
  });

  it("tool_end는 running에서 done으로 옮기며 status를 바꾼다", () => {
    const state = reduceAll([toolStart, { type: "tool_end", toolUseId: "t1", isError: false, summary: "ok" }]);
    expect(state.running).toEqual([]);
    expect(state.done).toHaveLength(1);
    expect(state.done[0]).toMatchObject({ kind: "tool", toolUseId: "t1", status: "done" });
  });

  it("오류로 끝난 도구는 error 상태와 errorSummary를 갖는다", () => {
    const state = reduceAll([toolStart, { type: "tool_end", toolUseId: "t1", isError: true, summary: "없음" }]);
    expect(state.done[0]).toMatchObject({ kind: "tool", status: "error", errorSummary: "없음" });
  });

  it("알 수 없는 toolUseId의 tool_end는 무시한다", () => {
    const state = reduceAll([toolStart, { type: "tool_end", toolUseId: "zz", isError: false, summary: "" }]);
    expect(state.running).toHaveLength(1);
    expect(state.done).toEqual([]);
  });

  it("병렬 도구는 끝난 것만 옮긴다", () => {
    const state = reduceAll([
      toolStart,
      { ...toolStart, toolUseId: "t2" },
      { type: "tool_end", toolUseId: "t2", isError: false, summary: "" },
    ]);
    expect(state.running.map((tool) => tool.toolUseId)).toEqual(["t1"]);
    expect(state.done).toHaveLength(1);
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
