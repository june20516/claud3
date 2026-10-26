import { stripVTControlCharacters } from "node:util";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { HISTORY_LINE_LIMIT, historyLines, loadHistoryLines } from "../src/sessionHistory.js";

function message(type: SessionMessage["type"], content: unknown, extra: Record<string, unknown> = {}): SessionMessage {
  return {
    type,
    uuid: "u",
    session_id: "s1",
    message: { role: type, content },
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
  } as SessionMessage;
}

function plain(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line));
}

describe("historyLines", () => {
  it("사용자 입력, 응답, 도구 호출을 화면과 같은 모양으로 빈 줄을 사이에 두고 그린다", () => {
    const lines = historyLines([
      message("user", "안녕\n둘째 줄"),
      message("assistant", [
        { type: "thinking", thinking: "생각" },
        { type: "text", text: "**네** 확인하겠습니다." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -a" } },
      ]),
      message("user", [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }]),
      message("assistant", [{ type: "text", text: "끝났습니다.\n" }]),
    ]);

    expect(plain(lines)).toEqual([
      "> 안녕",
      "둘째 줄",
      "",
      "네 확인하겠습니다.",
      "",
      "⏺ Bash(ls -a)",
      "",
      "끝났습니다.",
    ]);
  });

  it("응답은 마크다운으로 렌더링하고, 코드 블록 안은 그대로 둔다", () => {
    const lines = historyLines([message("assistant", [{ type: "text", text: "**굵게**\n```\n**그대로**\n```" }])]);

    expect(plain(lines)[0]).toBe("굵게");
    expect(plain(lines)).toContain("**그대로**");
  });

  it("배열로 온 사용자 입력은 text 블록만 쓴다", () => {
    const lines = historyLines([message("user", [{ type: "text", text: "배열 입력" }])]);

    expect(plain(lines)).toEqual(["> 배열 입력"]);
  });

  it("서브에이전트, 메타, compact 요약, 명령 기록 메시지는 뺀다", () => {
    const lines = historyLines([
      message("user", "요약", { isCompactSummary: true }),
      message("user", "메타", { is_meta: true }),
      message("user", "<command-name>/compact</command-name>"),
      message("user", "<local-command-stdout>Compacted</local-command-stdout>"),
      message("assistant", [{ type: "text", text: "서브에이전트" }], { parent_tool_use_id: "t1" }),
      message("system", "시스템"),
      message("user", "남는 입력"),
    ]);

    expect(plain(lines)).toEqual(["> 남는 입력"]);
  });

  it("마지막 limit 줄만 남기고, 잘린 앞쪽의 빈 줄은 버린다", () => {
    const lines = historyLines(
      [message("user", "첫 입력"), message("assistant", [{ type: "text", text: "1\n2\n3" }])],
      3,
    );

    expect(plain(lines)).toEqual(["1", "2", "3"]);
    expect(plain(historyLines([message("user", "a"), message("user", "b")], 2))).toEqual(["> b"]);
  });

  it("기본 줄 수는 100이다", () => {
    const text = Array.from({ length: 150 }, (_, index) => `줄 ${index + 1}`).join("\n");
    const lines = historyLines([message("assistant", [{ type: "text", text }])]);

    expect(HISTORY_LINE_LIMIT).toBe(100);
    expect(lines).toHaveLength(100);
    expect(plain(lines).at(-1)).toBe("줄 150");
  });
});

describe("loadHistoryLines", () => {
  it("주입한 reader로 세션 메시지를 읽어 줄로 바꾼다", async () => {
    const reader = vi.fn(async () => [message("user", "이전 입력")]);

    expect(plain(await loadHistoryLines("s1", reader))).toEqual(["> 이전 입력"]);
    expect(reader).toHaveBeenCalledWith("s1");
  });
});
