import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPersona } from "../src/persona/bootstrap.js";
import type { OneShotQueryFn } from "../src/persona/oneShot.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import { saveProfile } from "../src/persona/store.js";

const unusedQuery: OneShotQueryFn = () => {
  throw new Error("query should not be called");
};

function deps(dir: string) {
  return { queryFn: unusedQuery, env: {}, onCost: () => {}, onWarning: () => {}, dir };
}

describe("openPersona", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-bootstrap-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("인격이 하나도 없으면 만드는 방법을 안내한다", async () => {
    expect(await openPersona("rapi", deps(dir))).toEqual({
      ok: false,
      message: "인격 'rapi'을(를) 찾지 못했습니다. 사용 가능한 인격: (없음) — 세션에서 /persona-create <이름>으로 만드세요",
    });
  });

  it("없는 이름이면 사용 가능한 인격 목록을 보여 준다", async () => {
    const profile = JSON.parse(await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8")) as PersonaProfile;
    await saveProfile(profile, dir);
    await saveProfile({ ...profile, name: "naruto" }, dir);
    const result = await openPersona("ghost", deps(dir));
    expect(result).toEqual({ ok: false, message: "인격 'ghost'을(를) 찾지 못했습니다. 사용 가능한 인격: naruto, rapi" });
  });

  it("형식이 틀린 인격은 파일 경로와 문제 필드를 보여 준다", async () => {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ version: 1, name: "bad" }), "utf8");
    const result = await openPersona("bad", deps(dir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const [first, ...rest] = result.message.split("\n");
      expect(first).toBe(`인격 파일 형식 오류 (${join(dir, "bad.json")}):`);
      expect(rest.some((line) => line.startsWith("- displayName: "))).toBe(true);
    }
  });

  it("정상 인격이면 런타임을 만든다", async () => {
    const profile = JSON.parse(await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8")) as PersonaProfile;
    await saveProfile(profile, dir);
    const result = await openPersona("rapi", deps(dir));
    expect(result.ok && result.runtime.systemAppend).toContain("# 인격: 라피");
  });

  it("기분 파일이 깨졌으면 경고한다", async () => {
    const profile = JSON.parse(await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8")) as PersonaProfile;
    await saveProfile(profile, dir);
    await writeFile(join(dir, "rapi.mood.json"), "{", "utf8");
    const warnings: string[] = [];
    await openPersona("rapi", { ...deps(dir), onWarning: (message) => warnings.push(message) });
    expect(warnings).toEqual(["기분 파일이 깨져 새로 시작합니다"]);
  });
});
