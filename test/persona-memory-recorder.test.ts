import { readFileSync } from "node:fs";
import type { Options, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { MoodReason } from "../src/persona/mood.js";
import { emptyMemoryFile } from "../src/persona/memory/experience.js";
import type { MemoryFile, MoodMarker, TrackedSession } from "../src/persona/memory/experience.js";
import { createMemoryRecorder, createRecordModel } from "../src/persona/memory/recorder.js";
import type { MemoryRecorderDeps, RecordModel } from "../src/persona/memory/recorder.js";
import { OneShotQueryError } from "../src/persona/oneShot.js";
import type { PersonaProfile } from "../src/persona/profile.js";

const PROFILE = JSON.parse(
  readFileSync(new URL("./fixtures/persona-rapi.json", import.meta.url), "utf8"),
) as PersonaProfile;
const NOW = new Date("2026-11-19T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;
function message(type: "user" | "assistant", text: string): SessionMessage {
  counter++;
  const content = type === "user" ? text : [{ type: "text", text }];
  return { type, uuid: `m${counter}`, session_id: "s1", message: { role: type, content }, parent_tool_use_id: null, parent_agent_id: null };
}

function exchange(text: string): SessionMessage[] {
  return [message("user", text), message("assistant", `${text} 답`)];
}

function modelReturning(...outputs: unknown[]): RecordModel & ReturnType<typeof vi.fn> {
  const queue = [...outputs];
  return vi.fn(async (_prompt: string) => ({ output: queue.shift() ?? { experiences: [] }, costUsd: 0.002 }));
}

const remembered = { experiences: [{ summary: "칭찬을 들었다", feeling: "…별거 아니에요.", importance: 2 }] };

function setup(overrides: Partial<MemoryRecorderDeps> = {}, initialFile: MemoryFile = emptyMemoryFile()) {
  const sessionsMessages = new Map<string, SessionMessage[]>([["s1", exchange("첫 대화")]]);
  const saved: MemoryFile[] = [];
  const warnings: string[] = [];
  const costs: number[] = [];
  const reasons: MoodReason[] = [];
  const markers: MoodMarker[] = [];
  const deps: MemoryRecorderDeps = {
    profile: PROFILE,
    initialFile,
    readMessages: vi.fn(async (sessionId: string) => sessionsMessages.get(sessionId) ?? []),
    model: modelReturning(remembered),
    save: vi.fn(async (file: MemoryFile) => {
      saved.push(file);
      return file;
    }),
    moodContext: () => ({ reasons, markers }),
    clock: () => NOW,
    onCost: (usd) => costs.push(usd),
    onWarning: (text) => warnings.push(text),
    onChange: vi.fn(),
    ...overrides,
  };
  const recorder = createMemoryRecorder(deps);
  return { recorder, deps, sessionsMessages, saved, warnings, costs, reasons, markers };
}

const sessionOf = (file: MemoryFile, id = "s1"): TrackedSession | undefined => file.sessions.find((item) => item.sessionId === id);

describe("createMemoryRecorder", () => {
  it("등록은 바로 저장한다(커서 null)", async () => {
    const { recorder, saved } = setup();
    recorder.register("s1", "/work");
    await recorder.request("none");
    expect(sessionOf(saved.at(-1) ?? emptyMemoryFile())).toMatchObject({ cwd: "/work", cursor: null, failures: 0 });
  });

  it("기록하면 경험을 더하고 커서를 옮겨 저장한다", async () => {
    const { recorder, deps, sessionsMessages, saved } = setup();
    recorder.register("s1", "/work");
    await recorder.request("s1");
    const file = saved.at(-1) ?? emptyMemoryFile();
    expect(deps.model).toHaveBeenCalledTimes(1);
    expect(file.experiences).toMatchObject([{ summary: "칭찬을 들었다", importance: 2, sessionId: "s1", at: NOW.toISOString() }]);
    expect(sessionOf(file)).toMatchObject({ cursor: sessionsMessages.get("s1")?.at(-1)?.uuid, failures: 0, recordedUntil: NOW.toISOString() });
    expect(deps.onChange).toHaveBeenCalledWith(file);
    expect(recorder.current()).toEqual(file);
  });

  it("0개를 골라도 커서는 옮긴다", async () => {
    const { recorder, saved, sessionsMessages } = setup({ model: modelReturning({ experiences: [] }) });
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(saved.at(-1)?.experiences).toEqual([]);
    expect(sessionOf(saved.at(-1) ?? emptyMemoryFile())?.cursor).toBe(sessionsMessages.get("s1")?.at(-1)?.uuid);
  });

  it("사용자 입력이 없는 구간은 모델을 부르지 않는다", async () => {
    const { recorder, deps, sessionsMessages } = setup();
    sessionsMessages.set("s1", [message("assistant", "혼잣말")]);
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(deps.model).not.toHaveBeenCalled();
    expect(sessionOf(recorder.current())?.cursor).toBeNull();
  });

  it("모델이 실패하면 커서를 두고 실패를 센다, 세 번이면 넘긴다, 경고는 한 번", async () => {
    const model = vi.fn(async () => {
      throw new Error("시간 초과");
    });
    const { recorder, sessionsMessages, warnings } = setup({ model });
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(sessionOf(recorder.current())).toMatchObject({ cursor: null, failures: 1 });
    await recorder.request("s1");
    await recorder.request("s1");
    expect(sessionOf(recorder.current())).toMatchObject({ cursor: sessionsMessages.get("s1")?.at(-1)?.uuid, failures: 0 });
    expect(warnings).toEqual(["인격 기억을 기록하지 못했습니다: 시간 초과"]);
  });

  it("출력 형식이 틀리면 실패로 센다", async () => {
    const { recorder } = setup({ model: modelReturning({ wrong: true }) });
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(sessionOf(recorder.current())?.failures).toBe(1);
  });

  it("실패한 호출의 비용도 기록한다", async () => {
    const model = vi.fn(async () => {
      throw new OneShotQueryError("error_max_budget_usd", 0.01);
    });
    const { recorder, costs } = setup({ model });
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(costs).toEqual([0.01]);
  });

  it("성공한 호출의 비용을 기록한다", async () => {
    const { recorder, costs } = setup();
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(costs).toEqual([0.002]);
  });

  it("저장이 실패하면 저장 전 상태로 두고 다음에 같은 구간을 다시 기록한다", async () => {
    let failSave = true;
    const saved: MemoryFile[] = [];
    const save = vi.fn(async (file: MemoryFile) => {
      if (failSave) {
        throw new Error("권한 없음");
      }
      saved.push(file);
      return file;
    });
    const { recorder, deps, warnings } = setup({ save, model: modelReturning(remembered, remembered) });
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(recorder.current().experiences).toEqual([]);
    expect(sessionOf(recorder.current())).toMatchObject({ cursor: null, failures: 0 });
    expect(warnings).toEqual(["인격 기억을 기록하지 못했습니다: 권한 없음"]);
    failSave = false;
    await recorder.request("s1");
    expect(deps.model).toHaveBeenCalledTimes(2);
    expect(saved.at(-1)?.experiences).toHaveLength(1);
  });

  it("기록 중에 온 같은 세션 요청은 끝난 뒤 새 커서부터 한 번 더, 대기 중 요청은 합친다", async () => {
    let release: () => void = () => undefined;
    const prompts: string[] = [];
    const model = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { output: { experiences: [] }, costUsd: 0 };
    });
    const { recorder, sessionsMessages } = setup({ model });
    recorder.register("s1", "/work");
    const first = recorder.request("s1");
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    sessionsMessages.set("s1", [...(sessionsMessages.get("s1") ?? []), ...exchange("새 대화")]);
    const second = recorder.request("s1");
    const third = recorder.request("s1");
    expect(third).toBe(second);
    release();
    await Promise.all([first, second, third]);
    expect(model).toHaveBeenCalledTimes(2);
    const segmentPart = prompts[1]?.split("## 대화 구간")[1] ?? "";
    expect(segmentPart).toContain("사용자: 새 대화");
    expect(segmentPart).not.toContain("사용자: 첫 대화");
  });

  it("등록 안 된 세션은 아무것도 하지 않는다", async () => {
    const { recorder, deps } = setup();
    await recorder.request("unknown");
    expect(deps.readMessages).not.toHaveBeenCalled();
  });

  it("세션 기록을 읽지 못하면 이번만 건너뛴다", async () => {
    const { recorder, deps, warnings } = setup({
      readMessages: vi.fn(async () => {
        throw new Error("세션 파일 없음");
      }),
    });
    recorder.register("s1", "/work");
    await recorder.request("s1");
    expect(deps.model).not.toHaveBeenCalled();
    expect(sessionOf(recorder.current())?.cursor).toBeNull();
    expect(warnings).toEqual(["인격 기억을 기록하지 못했습니다: 세션 파일 없음"]);
  });

  it("따라잡기는 저장된 cwd로 읽고, 오래 못 읽은 세션은 정리한다", async () => {
    const session = (sessionId: string, cwd: string, readDaysAgo: number): TrackedSession => ({
      sessionId,
      cwd,
      cursor: null,
      failures: 0,
      lastSeenAt: new Date(NOW.getTime() - readDaysAgo * DAY_MS).toISOString(),
      lastReadAt: new Date(NOW.getTime() - readDaysAgo * DAY_MS).toISOString(),
      recordedUntil: new Date(NOW.getTime() - readDaysAgo * DAY_MS).toISOString(),
    });
    const initial: MemoryFile = { ...emptyMemoryFile(), sessions: [session("s1", "/other/project", 1), session("stale", "/old", 31)] };
    const { recorder, deps } = setup({}, initial);
    await recorder.catchUp();
    expect(deps.readMessages).toHaveBeenCalledWith("s1", "/other/project");
    expect(deps.readMessages).not.toHaveBeenCalledWith("stale", "/old");
    expect(recorder.current().sessions.map((item) => item.sessionId)).toEqual(["s1"]);
  });

  it("프롬프트에 구간 시간대(등록 이후)의 기분 이유와 표시점을 넣는다", async () => {
    let prompt = "";
    let now = NOW;
    const model = vi.fn(async (text: string) => {
      prompt = text;
      return { output: { experiences: [] }, costUsd: 0 };
    });
    const { recorder, reasons, markers } = setup({ model, clock: () => now });
    recorder.register("s1", "/work");
    reasons.push({ at: new Date(NOW.getTime() - 60_000).toISOString(), text: "등록 전 이유", stress: 1, dopamine: 0 });
    reasons.push({ at: new Date(NOW.getTime() + 60_000).toISOString(), text: "칭찬", stress: -4, dopamine: 8 });
    markers.push({ at: new Date(NOW.getTime() + 60_000).toISOString(), text: "극단 진입: 들뜸" });
    now = new Date(NOW.getTime() + 120_000);
    await recorder.request("s1");
    expect(prompt).toContain("칭찬");
    expect(prompt).toContain("극단 진입: 들뜸");
    expect(prompt).not.toContain("등록 전 이유");
  });
});

describe("createRecordModel", () => {
  it("도구 없이 격리한 Haiku 호출 옵션", async () => {
    let received: Options | undefined;
    const queryFn = (params: { prompt: string; options: Options }): AsyncIterable<SDKMessage> => {
      received = params.options;
      return (async function* () {
        yield { type: "result", subtype: "success", structured_output: { experiences: [] }, total_cost_usd: 0.001 } as unknown as SDKMessage;
      })();
    };
    const result = await createRecordModel(queryFn, { ANTHROPIC_API_KEY: "k" })("프롬프트");
    expect(result).toEqual({ output: { experiences: [] }, costUsd: 0.001 });
    expect(received).toMatchObject({
      model: "claude-haiku-5-5",
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 3,
      maxBudgetUsd: 0.05,
      outputFormat: { type: "json_schema" },
    });
  });
});
