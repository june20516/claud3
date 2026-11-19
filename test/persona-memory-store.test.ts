import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyMemoryFile } from "../src/persona/memory/experience.js";
import type { Experience, MemoryFile } from "../src/persona/memory/experience.js";
import { loadMemories, memoriesPath, saveMemories } from "../src/persona/memory/memoryStore.js";

function experience(id: string): Experience {
  return {
    id,
    summary: `${id} 요약`,
    feeling: "음.",
    importance: 2,
    at: "2026-11-19T06:41:00.000Z",
    sessionId: "s1",
    moodReasons: [],
    moodDelta: { stress: 0, dopamine: 0 },
  };
}

function withExperiences(...ids: string[]): MemoryFile {
  return { ...emptyMemoryFile(), experiences: ids.map(experience) };
}

describe("memoryStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-memory-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("경로는 <dir>/<이름>.memories.json", () => {
    expect(memoriesPath("yuri", dir)).toBe(join(dir, "yuri.memories.json"));
  });

  it("파일이 없으면 빈 기억", async () => {
    expect(await loadMemories("yuri", dir)).toEqual({ file: emptyMemoryFile() });
  });

  it("저장한 것을 다시 읽는다", async () => {
    await saveMemories("yuri", withExperiences("a"), dir);
    expect((await loadMemories("yuri", dir)).file).toEqual(withExperiences("a"));
  });

  it("깨진 파일은 .broken으로 옮기고 경고와 함께 빈 기억", async () => {
    await writeFile(memoriesPath("yuri", dir), "{ 깨짐", "utf8");
    expect(await loadMemories("yuri", dir)).toEqual({ file: emptyMemoryFile(), warning: "기억 파일이 깨져 새로 시작합니다" });
    await expect(access(`${memoriesPath("yuri", dir)}.broken`)).resolves.toBeUndefined();
  });

  it("저장 직전에 디스크 파일과 합친다", async () => {
    await saveMemories("yuri", withExperiences("other-process"), dir);
    const merged = await saveMemories("yuri", withExperiences("mine"), dir);
    const ids = merged.experiences.map((item) => item.id).sort();
    expect(ids).toEqual(["mine", "other-process"]);
    const onDisk = JSON.parse(await readFile(memoriesPath("yuri", dir), "utf8")) as MemoryFile;
    expect(onDisk.experiences.map((item) => item.id).sort()).toEqual(ids);
  });

  it("디스크 파일이 깨졌으면 합치지 않고 내 것을 쓴다", async () => {
    await writeFile(memoriesPath("yuri", dir), "{ 깨짐", "utf8");
    expect(await saveMemories("yuri", withExperiences("mine"), dir)).toEqual(withExperiences("mine"));
  });

  it("임시 파일이 남지 않는다", async () => {
    await saveMemories("yuri", withExperiences("a"), dir);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
