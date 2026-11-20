import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPersona } from "../src/persona/bootstrap.js";
import type { OneShotQueryFn } from "../src/persona/oneShot.js";
import type { PersonaProfile } from "../src/persona/profile.js";
import { loadMemories, memoriesPath, saveMemories } from "../src/persona/memory/memoryStore.js";
import { emptyMemoryFile } from "../src/persona/memory/experience.js";
import { saveProfile } from "../src/persona/store.js";

const unusedQuery: OneShotQueryFn = () => {
  throw new Error("query should not be called");
};

function deps(dir: string) {
  return { queryFn: unusedQuery, env: {}, onCost: () => {}, onWarning: () => {}, dir, readMessages: async () => [] };
}

describe("openPersona", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-bootstrap-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("이름 형식이 틀리면 파일을 찾지 않고 거부한다", async () => {
    expect(await openPersona("../foo", deps(dir))).toEqual({
      ok: false,
      message: "인격 이름은 소문자·숫자·_·- 1~32자여야 합니다: ../foo",
    });
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

  describe("기억", () => {
    async function saveFixture(): Promise<void> {
      const profile = JSON.parse(await readFile(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8")) as PersonaProfile;
      await saveProfile(profile, dir);
    }

    const message = (type: "user" | "assistant", uuid: string, text: string): SessionMessage => ({
      type,
      uuid,
      session_id: "old",
      message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
      parent_tool_use_id: null,
      parent_agent_id: null,
    });

    const trackedSession = {
      sessionId: "old",
      cwd: "/other/project",
      cursor: null,
      failures: 0,
      lastSeenAt: new Date().toISOString(),
      lastReadAt: null,
      recordedUntil: new Date().toISOString(),
    };

    it("기억 파일이 없으면 기억 단락 없이 열고 PreCompact 훅이 있다", async () => {
      await saveFixture();
      const result = await openPersona("rapi", deps(dir));
      expect(result.ok && result.runtime.systemAppend).not.toContain("## 기억");
      expect(result.ok && result.runtime.hooks.PreCompact).toBeTruthy();
    });

    it("기억이 있으면 시작 기억을 append에 넣는다", async () => {
      await saveFixture();
      const memory = {
        id: "e1",
        summary: "main이 바뀌어 있었다",
        feeling: "다행이었어요.",
        importance: 2 as const,
        at: new Date().toISOString(),
        sessionId: "old",
        moodReasons: [],
        moodDelta: { stress: 0, dopamine: 0 },
      };
      await saveMemories("rapi", { ...emptyMemoryFile(), experiences: [memory] }, dir);
      const result = await openPersona("rapi", deps(dir));
      expect(result.ok && result.runtime.systemAppend).toContain("main이 바뀌어 있었다 (다행이었어요.)");
    });

    it("깨진 기억 파일은 경고하고 연다", async () => {
      await saveFixture();
      await writeFile(memoriesPath("rapi", dir), "{", "utf8");
      const warnings: string[] = [];
      const result = await openPersona("rapi", { ...deps(dir), onWarning: (text) => warnings.push(text) });
      expect(result.ok).toBe(true);
      expect(warnings).toEqual(["기억 파일이 깨져 새로 시작합니다"]);
    });

    it("커서 뒤에 대화가 남은 세션을 따라잡아 기록한다", async () => {
      await saveFixture();
      await saveMemories("rapi", { ...emptyMemoryFile(), sessions: [trackedSession] }, dir);
      const queryFn = vi.fn(() =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            structured_output: { experiences: [{ summary: "칭찬을 들었다", feeling: "…흥.", importance: 2 }] },
            total_cost_usd: 0.001,
          } as unknown as SDKMessage;
        })(),
      );
      const readMessages = vi.fn(async () => [message("user", "m1", "잘했어"), message("assistant", "m2", "…네.")]);
      await openPersona("rapi", { ...deps(dir), queryFn, readMessages });
      await vi.waitFor(async () => {
        const { file } = await loadMemories("rapi", dir);
        expect(file.experiences.map((item) => item.summary)).toEqual(["칭찬을 들었다"]);
        expect(file.sessions[0]?.cursor).toBe("m2");
      });
      expect(readMessages).toHaveBeenCalledWith("old", "/other/project");
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it("남은 대화가 없으면 모델을 부르지 않는다", async () => {
      await saveFixture();
      await saveMemories("rapi", { ...emptyMemoryFile(), sessions: [{ ...trackedSession, cursor: "m2" }] }, dir);
      const queryFn = vi.fn(unusedQuery);
      const readMessages = vi.fn(async () => [message("user", "m1", "잘했어"), message("assistant", "m2", "…네.")]);
      await openPersona("rapi", { ...deps(dir), queryFn, readMessages });
      // 읽은 시각을 저장할 때까지 기다린다(그 전에 끝내면 임시 디렉터리 삭제와 겹친다).
      await vi.waitFor(async () => {
        const { file } = await loadMemories("rapi", dir);
        expect(file.sessions[0]?.lastReadAt).not.toBeNull();
      });
      expect(queryFn).not.toHaveBeenCalled();
    });
  });
});
