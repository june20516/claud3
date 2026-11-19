import { describe, expect, it } from "vitest";
import {
  emptyMemoryFile,
  mergeMemoryFiles,
  parseMemoryFile,
  pruneExperiences,
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

  it("한쪽에만 있는 세션도 남긴다", () => {
    const merged = mergeMemoryFiles(file([], [session({ sessionId: "d" })]), file([], [session({ sessionId: "m" })]));
    expect(merged.sessions.map((item) => item.sessionId).sort()).toEqual(["d", "m"]);
  });
});
