import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialMood } from "../src/persona/mood.js";
import type { MoodState } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import { parseMemoryStatusLevel, signalEvents } from "../src/persona/signals.js";
import type { SignalSources } from "../src/persona/signals.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;
const OFFICE_PROFILE: PersonaProfile = { ...PROFILE, workHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" } };
const WEDNESDAY_10 = new Date(2026, 10, 4, 10, 0);
const WEDNESDAY_20 = new Date(2026, 10, 4, 20, 0);
const SATURDAY = new Date(2026, 10, 7, 10, 0);

function sources(overrides: Partial<SignalSources> = {}): SignalSources {
  return {
    now: WEDNESDAY_10,
    readMemoryAvailablePercent: async () => 50,
    loadAverage1m: 1,
    cpuCount: 8,
    ...overrides,
  };
}

function freshState(now: Date): MoodState {
  return initialMood(now);
}

describe("parseMemoryStatusLevel", () => {
  it("숫자 한 줄을 읽고, 아니면 undefined", () => {
    expect(parseMemoryStatusLevel("81\n")).toBe(81);
    expect(parseMemoryStatusLevel("abc")).toBeUndefined();
  });
});

describe("signalEvents", () => {
  it("평일 업무 시간, 여유 있는 시스템이면 신호 없음", async () => {
    expect(await signalEvents(freshState(WEDNESDAY_10), OFFICE_PROFILE, sources(), true)).toEqual([]);
  });

  it("메모리 여유율 15% 미만이면 memoryPressure, 읽지 못하면 건너뜀", async () => {
    const low = sources({ readMemoryAvailablePercent: async () => 14 });
    expect(await signalEvents(freshState(WEDNESDAY_10), PROFILE, low, false)).toEqual([{ kind: "memoryPressure" }]);
    const unknown = sources({ readMemoryAvailablePercent: async () => undefined });
    expect(await signalEvents(freshState(WEDNESDAY_10), PROFILE, unknown, false)).toEqual([]);
  });

  it("1분 loadavg ÷ 코어 수가 0.8을 넘으면 cpuBusy", async () => {
    expect(await signalEvents(freshState(WEDNESDAY_10), PROFILE, sources({ loadAverage1m: 7 }), false)).toEqual([
      { kind: "cpuBusy" },
    ]);
  });

  it("주말 세션의 첫 입력에만 weekendStart", async () => {
    const weekend = sources({ now: SATURDAY });
    expect(await signalEvents(freshState(SATURDAY), PROFILE, weekend, true)).toEqual([{ kind: "weekendStart" }]);
    expect(await signalEvents(freshState(SATURDAY), PROFILE, weekend, false)).toEqual([]);
  });

  it("업무 시간이 정해진 인격에게 업무 시간 밖에 말을 걸면 afterHours", async () => {
    const evening = sources({ now: WEDNESDAY_20 });
    expect(await signalEvents(freshState(WEDNESDAY_20), OFFICE_PROFILE, evening, false)).toEqual([{ kind: "afterHours" }]);
    expect(await signalEvents(freshState(WEDNESDAY_20), PROFILE, evening, false)).toEqual([]);
  });

  it("마지막 갱신 후 8시간이 넘었으면 returnAfterBreak", async () => {
    const longAgo = initialMood(new Date(WEDNESDAY_10.getTime() - 9 * 3_600_000));
    expect(await signalEvents(longAgo, PROFILE, sources(), false)).toEqual([{ kind: "returnAfterBreak" }]);
  });
});
