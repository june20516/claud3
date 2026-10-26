import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { formatSessionTime, loadSessionList, SESSION_LIST_LIMIT } from "../src/sessionList.js";

function info(sessionId: string, lastModified: number, extra: Partial<SDKSessionInfo> = {}): SDKSessionInfo {
  return { sessionId, summary: `${sessionId} 요약`, lastModified, ...extra };
}

describe("loadSessionList", () => {
  it("cwd의 세션을 최신순으로 정렬하고 제목과 마지막 대화 시간을 돌려준다", async () => {
    const lister = vi.fn(async () => [info("a", 100), info("c", 300), info("b", 200)]);

    const items = await loadSessionList({ cwd: "/work", lister });

    expect(lister).toHaveBeenCalledWith({ dir: "/work", limit: SESSION_LIST_LIMIT });
    expect(items).toEqual([
      { sessionId: "c", title: "c 요약", lastModified: 300 },
      { sessionId: "b", title: "b 요약", lastModified: 200 },
      { sessionId: "a", title: "a 요약", lastModified: 100 },
    ]);
  });

  it("지금 열린 세션은 뺀다", async () => {
    const items = await loadSessionList({
      cwd: "/work",
      excludeSessionId: "b",
      lister: async () => [info("a", 100), info("b", 200)],
    });

    expect(items.map((item) => item.sessionId)).toEqual(["a"]);
  });

  it("제목은 첫 줄만 쓰고, 비어 있으면 대신할 문구를 쓴다", async () => {
    const items = await loadSessionList({
      cwd: "/work",
      lister: async () => [info("a", 200, { summary: "  첫 줄\n둘째 줄" }), info("b", 100, { summary: " " })],
    });

    expect(items.map((item) => item.title)).toEqual(["첫 줄", "(제목 없음)"]);
  });
});

describe("formatSessionTime", () => {
  const now = new Date(2026, 9, 26, 15, 0).getTime();

  it("월/일 시:분과 지난 시간을 함께 보인다", () => {
    expect(formatSessionTime(new Date(2026, 9, 26, 14, 57, 30).getTime(), now)).toBe("10/26 14:57 · 2분 전");
    expect(formatSessionTime(new Date(2026, 9, 26, 14, 59, 40).getTime(), now)).toBe("10/26 14:59 · 방금");
    expect(formatSessionTime(new Date(2026, 9, 26, 9, 5).getTime(), now)).toBe("10/26 09:05 · 5시간 전");
    expect(formatSessionTime(new Date(2026, 9, 23, 15, 0).getTime(), now)).toBe("10/23 15:00 · 3일 전");
  });

  it("올해가 아니면 연도를 붙인다", () => {
    expect(formatSessionTime(new Date(2025, 11, 31, 23, 0).getTime(), now)).toBe("2025/12/31 23:00 · 298일 전");
  });
});
