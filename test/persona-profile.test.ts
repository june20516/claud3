import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValidPersonaName, parseDraft, validateProfile } from "../src/persona/profile.js";

function loadFixture(): Record<string, unknown> {
  const raw = readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function issuePaths(value: unknown): string[] {
  const result = validateProfile(value);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe("validateProfile", () => {
  it("spec 예시 인격은 통과한다", () => {
    const result = validateProfile(loadFixture());
    expect(result.ok).toBe(true);
  });

  it("민감도가 1~5 밖이면 그 필드 경로를 알려 준다", () => {
    const profile = loadFixture();
    profile.sensitivity = { stress: 6, dopamine: 3 };
    expect(issuePaths(profile)).toContain("sensitivity.stress");
  });

  it("극단 방향 성향이 빠지면 경로를 알려 준다", () => {
    const profile = loadFixture();
    const directions = profile.directions as Record<string, Record<string, unknown>>;
    delete directions.hot!.extreme;
    expect(issuePaths(profile)).toContain("directions.hot.extreme");
  });

  it("반응 수치가 ±40을 넘거나 키워드가 비면 경로를 알려 준다", () => {
    const profile = loadFixture();
    profile.reactions = [{ keywords: [], stress: 41, dopamine: 0, note: "" }];
    const paths = issuePaths(profile);
    expect(paths).toContain("reactions[0].stress");
    expect(paths).toContain("reactions[0].keywords");
  });

  it("workHours는 null을 허용하고, 요일이 0~6 밖이면 거부한다", () => {
    const profile = loadFixture();
    profile.workHours = null;
    expect(validateProfile(profile).ok).toBe(true);
    profile.workHours = { days: [7], start: "09:00", end: "18:00" };
    expect(issuePaths(profile)).toContain("workHours.days");
  });

  it("이름 형식이 틀리면 name 경로를 알려 준다", () => {
    const profile = loadFixture();
    profile.name = "Rapi";
    expect(issuePaths(profile)).toContain("name");
  });

  it("객체가 아니면 실패한다", () => {
    expect(validateProfile("x").ok).toBe(false);
  });
});

describe("parseDraft", () => {
  it("형식이 맞는 최상위 필드만 남긴다", () => {
    expect(parseDraft({ summary: "x", sensitivity: { stress: 9, dopamine: 1 }, bogus: 1 })).toEqual({ summary: "x" });
  });

  it("객체가 아니면 빈 초안", () => {
    expect(parseDraft(null)).toEqual({});
  });
});

describe("isValidPersonaName", () => {
  it("소문자·숫자·_·- 1~32자만 허용한다", () => {
    expect(isValidPersonaName("rapi_2")).toBe(true);
    expect(isValidPersonaName("라피")).toBe(false);
    expect(isValidPersonaName("")).toBe(false);
    expect(isValidPersonaName("a".repeat(33))).toBe(false);
  });
});
