import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialMood } from "../src/persona/mood.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import { listPersonas, loadMood, loadProfile, personasDir, saveMood, saveProfile } from "../src/persona/store.js";

const NOW = new Date(2026, 10, 4, 10, 0);

async function fixtureProfile(): Promise<PersonaProfile> {
  return JSON.parse(await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8")) as PersonaProfile;
}

describe("persona store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-persona-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("기본 위치는 configDir 아래 personas", () => {
    const previous = process.env.CLAUD3_CONFIG_DIR;
    process.env.CLAUD3_CONFIG_DIR = "/tmp/claud3-x";
    try {
      expect(personasDir()).toBe("/tmp/claud3-x/personas");
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUD3_CONFIG_DIR;
      } else {
        process.env.CLAUD3_CONFIG_DIR = previous;
      }
    }
  });

  it("저장한 인격을 다시 읽는다", async () => {
    const profile = await fixtureProfile();
    const path = await saveProfile(profile, dir);
    expect(path).toBe(join(dir, "rapi.json"));
    expect(await loadProfile("rapi", dir)).toEqual({ ok: true, profile });
  });

  it("목록은 이름순이고 기분 파일은 빠진다. 디렉터리가 없으면 빈 목록", async () => {
    expect(await listPersonas(join(dir, "none"))).toEqual([]);
    const profile = await fixtureProfile();
    await saveProfile({ ...profile, name: "zed" }, dir);
    await saveProfile(profile, dir);
    await saveMood("rapi", initialMood(NOW), dir);
    expect(await listPersonas(dir)).toEqual(["rapi", "zed"]);
  });

  it("없는 인격은 missing", async () => {
    expect(await loadProfile("ghost", dir)).toEqual({ ok: false, reason: "missing" });
  });

  it("형식이 틀린 인격은 invalid와 문제 목록", async () => {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ version: 1 }), "utf8");
    const result = await loadProfile("bad", dir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason === "invalid" && result.issues.length).toBeGreaterThan(0);
  });

  it("JSON이 깨진 인격도 invalid", async () => {
    await writeFile(join(dir, "broken.json"), "{ 깨진", "utf8");
    const result = await loadProfile("broken", dir);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("기분 파일이 없으면 초기 상태", async () => {
    expect(await loadMood("rapi", NOW, dir)).toEqual({ state: initialMood(NOW) });
  });

  it("저장한 기분을 다시 읽는다", async () => {
    const state = { ...initialMood(NOW), stress: 42 };
    await saveMood("rapi", state, dir);
    expect(await loadMood("rapi", NOW, dir)).toEqual({ state });
  });

  it("깨진 기분 파일은 .broken으로 옮기고 경고와 함께 초기 상태로 시작한다", async () => {
    await writeFile(join(dir, "rapi.mood.json"), "{ 깨진", "utf8");
    const result = await loadMood("rapi", NOW, dir);
    expect(result).toEqual({ state: initialMood(NOW), warning: "기분 파일이 깨져 새로 시작합니다" });
    await expect(access(join(dir, "rapi.mood.json.broken"))).resolves.toBeUndefined();
  });
});
