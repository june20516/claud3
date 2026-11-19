import { describe, expect, it } from "vitest";
import {
  emptyMemoryFile,
  mergeMemoryFiles,
  parseMemoryFile,
  pruneExperiences,
  recallEvent,
  recallMemories,
  selectStartupMemories,
  summarizeSegmentMood,
  trimSessions,
} from "../src/persona/memory/experience.js";
import type { Experience, MemoryFile, TrackedSession } from "../src/persona/memory/experience.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-19T08:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function experience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: "2026-11-19T06:41:00.000Z-0",
    summary: "main이 바뀌어 있었다",
    feeling: "다행이었어요.",
    importance: 2,
    at: "2026-11-19T06:41:00.000Z",
    sessionId: "s1",
    moodReasons: ["테스트 통과"],
    moodDelta: { stress: 4, dopamine: 6 },
    ...overrides,
  };
}

function session(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    sessionId: "s1",
    cwd: "/work",
    cursor: null,
    failures: 0,
    lastSeenAt: daysAgo(0),
    lastReadAt: daysAgo(0),
    recordedUntil: daysAgo(0),
    ...overrides,
  };
}

function file(experiences: Experience[] = [], sessions: TrackedSession[] = []): MemoryFile {
  return { version: 1, experiences, sessions };
}

describe("parseMemoryFile", () => {
  it("정상 파일은 그대로 읽는다", () => {
    const original = file([experience()], [session({ cursor: "m1" })]);
    expect(parseMemoryFile(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it("최상위 형식이 틀리면 undefined", () => {
    expect(parseMemoryFile({ experiences: [], sessions: [] })).toBeUndefined();
    expect(parseMemoryFile({ version: 1, experiences: "x", sessions: [] })).toBeUndefined();
    expect(parseMemoryFile(null)).toBeUndefined();
  });

  it("깨진 항목만 버린다", () => {
    const parsed = parseMemoryFile({
      version: 1,
      experiences: [experience(), { ...experience({ id: "b" }), importance: 4 }, { ...experience({ id: "c" }), moodDelta: { stress: "x", dopamine: 1 } }],
      sessions: [session(), { sessionId: 3 }],
    });
    expect(parsed?.experiences.map((item) => item.id)).toEqual([experience().id]);
    expect(parsed?.sessions).toHaveLength(1);
  });

  it("긴 summary·feeling은 자른다", () => {
    const parsed = parseMemoryFile(file([experience({ summary: "가".repeat(130), feeling: "나".repeat(70) })]));
    expect(parsed?.experiences[0]?.summary).toHaveLength(120);
    expect(parsed?.experiences[0]?.feeling).toHaveLength(60);
  });

  it("cursor null과 lastReadAt null을 허용한다", () => {
    const parsed = parseMemoryFile(file([], [session({ cursor: null, lastReadAt: null })]));
    expect(parsed?.sessions[0]).toMatchObject({ cursor: null, lastReadAt: null });
  });

  it("emptyMemoryFile은 빈 목록", () => {
    expect(emptyMemoryFile()).toEqual(file());
  });
});

describe("pruneExperiences", () => {
  it("중요도 낮은 것, 같은 중요도면 오래된 것부터 지운다", () => {
    const oldLow = experience({ id: "oldLow", importance: 1, at: daysAgo(10) });
    const newLow = experience({ id: "newLow", importance: 1, at: daysAgo(1) });
    const oldestHigh = experience({ id: "oldestHigh", importance: 3, at: daysAgo(20) });
    const mid = experience({ id: "mid", importance: 2, at: daysAgo(5) });
    expect(pruneExperiences([oldLow, newLow, oldestHigh, mid], 2).map((item) => item.id)).toEqual(["oldestHigh", "mid"]);
  });

  it("한도 이하면 그대로(at 오름차순)", () => {
    const later = experience({ id: "later", at: daysAgo(1) });
    const earlier = experience({ id: "earlier", at: daysAgo(2) });
    expect(pruneExperiences([later, earlier], 5).map((item) => item.id)).toEqual(["earlier", "later"]);
  });
});

describe("trimSessions", () => {
  it("30일 넘게 못 읽은 세션은 뺀다", () => {
    const sessions = [session({ sessionId: "old", lastReadAt: daysAgo(31) }), session({ sessionId: "ok", lastReadAt: daysAgo(29) })];
    expect(trimSessions(sessions, NOW).map((item) => item.sessionId)).toEqual(["ok"]);
  });

  it("lastReadAt이 없으면 lastSeenAt으로 판단한다", () => {
    const sessions = [session({ sessionId: "seen", lastReadAt: null, lastSeenAt: daysAgo(31) })];
    expect(trimSessions(sessions, NOW)).toEqual([]);
  });

  it("최근 lastSeenAt 순 20개만 남긴다", () => {
    const sessions = Array.from({ length: 21 }, (_, index) => session({ sessionId: `s${index}`, lastSeenAt: daysAgo(index) }));
    const trimmed = trimSessions(sessions, NOW);
    expect(trimmed).toHaveLength(20);
    expect(trimmed.some((item) => item.sessionId === "s20")).toBe(false);
  });
});

describe("mergeMemoryFiles", () => {
  it("디스크에만 있는 경험을 지키고 같은 id는 내 것을 쓴다", () => {
    const disk = file([experience({ id: "a", summary: "디스크" }), experience({ id: "b" })]);
    const mine = file([experience({ id: "a", summary: "내 것" }), experience({ id: "c" })]);
    const merged = mergeMemoryFiles(disk, mine);
    expect(merged.experiences.map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
    expect(merged.experiences.find((item) => item.id === "a")?.summary).toBe("내 것");
  });

  it("같은 세션은 recordedUntil이 늦은 쪽 항목을 쓴다", () => {
    const disk = file([], [session({ cursor: "later", recordedUntil: daysAgo(0) })]);
    const mine = file([], [session({ cursor: "earlier", recordedUntil: daysAgo(1) })]);
    expect(mergeMemoryFiles(disk, mine).sessions[0]?.cursor).toBe("later");
  });

  it("합친 세션도 최근 lastSeenAt 순 20개까지", () => {
    const disk = file([], Array.from({ length: 15 }, (_, index) => session({ sessionId: `d${index}`, lastSeenAt: daysAgo(index + 10) })));
    const mine = file([], Array.from({ length: 10 }, (_, index) => session({ sessionId: `m${index}`, lastSeenAt: daysAgo(index) })));
    const merged = mergeMemoryFiles(disk, mine);
    expect(merged.sessions).toHaveLength(20);
    expect(merged.sessions.some((item) => item.sessionId === "d14")).toBe(false);
  });

  it("한쪽에만 있는 세션도 남긴다", () => {
    const merged = mergeMemoryFiles(file([], [session({ sessionId: "d" })]), file([], [session({ sessionId: "m" })]));
    expect(merged.sessions.map((item) => item.sessionId).sort()).toEqual(["d", "m"]);
  });
});

describe("selectStartupMemories", () => {
  it("중요도 내림차순, 같으면 최근 순 6개", () => {
    const highs = [experience({ id: "h1", importance: 3, at: daysAgo(30) }), experience({ id: "h2", importance: 3, at: daysAgo(40) })];
    const mids = [1, 2, 3, 4, 5].map((day) => experience({ id: `m${day}`, importance: 2, at: daysAgo(day) }));
    const { memories } = selectStartupMemories([...mids, ...highs]);
    expect(memories.map((item) => item.id)).toEqual(["h1", "h2", "m1", "m2", "m3", "m4"]);
  });

  it("기억이 없으면 빈 목록, lead 없음", () => {
    expect(selectStartupMemories([])).toEqual({ memories: [] });
  });

  it("가장 최근 세션의 중요도 3 기억이 lead", () => {
    const lead = experience({ id: "lead", sessionId: "latest", importance: 3, at: daysAgo(2) });
    const newest = experience({ id: "newest", sessionId: "latest", importance: 1, at: daysAgo(1) });
    const older = experience({ id: "older", sessionId: "old", importance: 3, at: daysAgo(5) });
    expect(selectStartupMemories([older, lead, newest]).lead?.id).toBe("lead");
  });

  it("최근 세션에 중요도 3이 없으면 lead 없음", () => {
    const newest = experience({ id: "newest", sessionId: "latest", importance: 2, at: daysAgo(1) });
    const older = experience({ id: "older", sessionId: "old", importance: 3, at: daysAgo(5) });
    expect(selectStartupMemories([older, newest]).lead).toBeUndefined();
  });
});

describe("recallMemories", () => {
  const compact = experience({ id: "compact", summary: "compact 명령 만들 때 main이 바뀌어 있었다" });
  const base = { experiences: [compact], excludeIds: new Set<string>(), lastRecalledTurn: new Map<string, number>(), turn: 20 };

  it("관련 있는 입력이면 떠올린다", () => {
    expect(recallMemories({ ...base, prompt: "compact 명령 또 손봐야겠다" })).toEqual([compact]);
  });

  it("무관한 입력이면 없다", () => {
    expect(recallMemories({ ...base, prompt: "오늘 점심 뭐 먹지" })).toEqual([]);
  });

  it("정규화 후 4자 미만이거나 행동 줄만 있으면 없다", () => {
    expect(recallMemories({ ...base, experiences: [experience({ summary: "ㅇㅇ" })], prompt: "ㅇㅇ" })).toEqual([]);
    expect(recallMemories({ ...base, experiences: [experience({ summary: "(츄르를 준다)" })], prompt: "(츄르를 준다)" })).toEqual([]);
  });

  it("제외 목록에 든 것은 뺀다", () => {
    expect(recallMemories({ ...base, excludeIds: new Set(["compact"]), prompt: "compact 명령 또 손봐야겠다" })).toEqual([]);
  });

  it("10턴 안에 떠올린 것은 뺀다", () => {
    const prompt = "compact 명령 또 손봐야겠다";
    expect(recallMemories({ ...base, lastRecalledTurn: new Map([["compact", 11]]), prompt })).toEqual([]);
    expect(recallMemories({ ...base, lastRecalledTurn: new Map([["compact", 10]]), prompt })).toEqual([compact]);
  });

  it("후보가 셋이면 유사도 높은 둘", () => {
    const exact = experience({ id: "exact", summary: "compact 명령 또 손봐야겠다" });
    const partial = experience({ id: "partial", summary: "compact 명령 만들었다" });
    const prompt = "compact 명령 또 손봐야겠다";
    expect(recallMemories({ ...base, experiences: [compact, partial, exact], prompt }).map((item) => item.id)).toEqual(["exact", "partial"]);
  });
});

describe("recallEvent", () => {
  it("변화 방향의 부호에 중요도 크기를 곱한다", () => {
    const item = experience({ importance: 2, moodDelta: { stress: -4, dopamine: 7 } });
    expect(recallEvent(item)).toEqual({ kind: "recall", summary: item.summary, stress: -5, dopamine: 5 });
  });

  it("변화가 없으면 이벤트 없음", () => {
    expect(recallEvent(experience({ moodDelta: { stress: 0, dopamine: 0 } }))).toBeUndefined();
  });
});

describe("summarizeSegmentMood", () => {
  const reason = (at: string, text: string, stress: number, dopamine: number) => ({ at, text, stress, dopamine });

  it("범위 안의 이유만 모으고 합계를 반올림한다", () => {
    const reasons = [
      reason(daysAgo(3), "범위 밖", 9, 9),
      reason(daysAgo(2), "시작 경계", 9, 9),
      reason(daysAgo(1), "도구 실패", 4.4, -1.3),
      reason(daysAgo(1), "도구 실패", 4.4, -1.3),
      reason(daysAgo(0), "테스트 통과", -3, 6),
    ];
    expect(summarizeSegmentMood(reasons, [], daysAgo(2), daysAgo(0))).toEqual({
      moodReasons: ["도구 실패", "테스트 통과"],
      moodDelta: { stress: 6, dopamine: 3 },
      strongHints: [],
    });
  });

  it("범위 안 표시점은 강한 후보", () => {
    const markers = [{ at: daysAgo(5), text: "오래됨" }, { at: daysAgo(1), text: "극단 진입: 뜨거운 과열" }];
    expect(summarizeSegmentMood([], markers, daysAgo(2), daysAgo(0)).strongHints).toEqual(["극단 진입: 뜨거운 과열"]);
  });
});
