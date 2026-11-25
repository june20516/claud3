import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildSegment } from "../src/persona/memory/segment.js";

let counter = 0;

function message(type: SessionMessage["type"], content: unknown, extra: Record<string, unknown> = {}): SessionMessage {
  counter++;
  return {
    type,
    uuid: `m${counter}`,
    session_id: "s1",
    message: { role: type, content },
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
  } as SessionMessage;
}

const user = (text: string, extra: Record<string, unknown> = {}) => message("user", text, extra);
const reply = (text: string) => message("assistant", [{ type: "text", text }]);
const toolUse = (id: string, name: string) => message("assistant", [{ type: "tool_use", id, name, input: { command: "ls" } }]);
const toolResult = (id: string, isError: boolean) =>
  message("user", [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "출력 본문" }]);

describe("buildSegment", () => {
  it("커서가 null이면 처음부터", () => {
    const messages = [user("안녕"), reply("네, 선배.")];
    expect(buildSegment(messages, null, "유리")).toEqual({
      lines: ["사용자: 안녕", "유리: 네, 선배."],
      context: [],
      lastUuid: messages[1]?.uuid,
      userInputs: 1,
    });
  });

  it("커서 다음부터 자르고, 커서가 마지막이면 undefined", () => {
    const messages = [user("하나"), reply("둘"), user("셋"), reply("넷")];
    expect(buildSegment(messages, messages[1]?.uuid ?? null, "유리")?.lines).toEqual(["사용자: 셋", "유리: 넷"]);
    expect(buildSegment(messages, messages[3]?.uuid ?? null, "유리")).toBeUndefined();
  });

  it("커서를 못 찾으면 마지막 compact 요약 다음부터", () => {
    const messages = [user("요약 전"), user("요약 본문", { isCompactSummary: true }), user("요약 후"), reply("응답")];
    expect(buildSegment(messages, "사라진 uuid", "유리")?.lines).toEqual(["사용자: 요약 후", "유리: 응답"]);
  });

  it("서브에이전트·메타·compact 요약·명령 기록은 뺀다", () => {
    const messages = [
      user("진짜 입력"),
      message("assistant", [{ type: "text", text: "서브에이전트" }], { parent_tool_use_id: "t9" }),
      user("메타", { is_meta: true }),
      user("<command-name>/compact</command-name>"),
      user("<local-command-stdout>Compacted</local-command-stdout>"),
    ];
    expect(buildSegment(messages, null, "유리")?.lines).toEqual(["사용자: 진짜 입력"]);
  });

  it("도구는 이름과 성공·실패만, 출력 본문은 넣지 않는다", () => {
    const messages = [user("해줘"), toolUse("t1", "Bash"), toolResult("t1", false), toolUse("t2", "Read"), toolResult("t2", true), toolUse("t3", "Edit")];
    const lines = buildSegment(messages, null, "유리")?.lines ?? [];
    expect(lines).toEqual(["사용자: 해줘", "⏺ Bash (성공)", "⏺ Read (실패)", "⏺ Edit (결과 없음)"]);
    expect(lines.join("\n")).not.toContain("출력 본문");
  });

  it("긴 입력·응답은 자른다", () => {
    const lines = buildSegment([user("가".repeat(1_200)), reply("나".repeat(500))], null, "유리")?.lines ?? [];
    expect(lines[0]).toBe(`사용자: ${"가".repeat(1_000)}…`);
    expect(lines[1]).toBe(`유리: ${"나".repeat(400)}…`);
  });

  it("전체가 한도를 넘으면 앞쪽을 버리고 생략 표시", () => {
    const messages = [user("첫째"), reply("하나"), user("둘째"), reply("둘")];
    const lines = buildSegment(messages, null, "유리", { userChars: 1_000, assistantChars: 400, totalChars: 15 })?.lines;
    expect(lines).toEqual(["(앞부분 생략)", "사용자: 둘째", "유리: 둘"]);
  });

  it("맥락은 커서 이전의 마지막 2쌍", () => {
    const messages = [user("a"), reply("1"), user("b"), reply("2"), user("c"), reply("3"), user("지금")];
    const segment = buildSegment(messages, messages[5]?.uuid ?? null, "유리");
    expect(segment?.context).toEqual(["사용자: b", "유리: 2", "사용자: c", "유리: 3"]);
  });

  it("응답만 있으면 사용자 입력 0", () => {
    const messages = [user("전"), reply("후속 응답")];
    expect(buildSegment(messages, messages[0]?.uuid ?? null, "유리")?.userInputs).toBe(0);
  });

  it("lastUuid는 마지막 메시지가 메타여도 그 uuid", () => {
    const messages = [user("입력"), user("메타", { is_meta: true })];
    expect(buildSegment(messages, null, "유리")?.lastUuid).toBe(messages[1]?.uuid);
  });
});
