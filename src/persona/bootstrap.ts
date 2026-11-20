import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { createReactionJudge } from "./actions.js";
import { selectStartupMemories } from "./memory/experience.js";
import type { Experience } from "./memory/experience.js";
import { loadMemories, saveMemories } from "./memory/memoryStore.js";
import { createMemoryRecorder, createRecordModel } from "./memory/recorder.js";
import type { OneShotQueryFn } from "./oneShot.js";
import { isValidPersonaName } from "./profile.js";
import { createPersonaRuntime } from "./runtime.js";
import type { PersonaRuntime } from "./runtime.js";
import { createSystemSignalSources } from "./signals.js";
import { listPersonas, loadMood, loadProfile, personasDir, profilePath, saveMood } from "./store.js";

export interface OpenPersonaDeps {
  queryFn: OneShotQueryFn;
  env: Record<string, string | undefined>;
  onCost: (usd: number) => void;
  onWarning: (message: string) => void;
  clock?: () => Date;
  /** 인격 디렉터리. 기본값은 personasDir(). */
  dir?: string;
  /** 세션 기록 읽기. 기본값은 SDK getSessionMessages(cwd 프로젝트에서). */
  readMessages?: (sessionId: string, cwd: string) => Promise<SessionMessage[]>;
}

export type OpenPersonaResult = { ok: true; runtime: PersonaRuntime } | { ok: false; message: string };

async function missingMessage(name: string, dir: string): Promise<string> {
  const names = await listPersonas(dir);
  const available = names.length > 0 ? names.join(", ") : "(없음) — 세션에서 /persona-create <이름>으로 만드세요";
  return `인격 '${name}'을(를) 찾지 못했습니다. 사용 가능한 인격: ${available}`;
}

/** --persona 이름으로 인격과 기분을 읽어 런타임을 만든다. 실패하면 사용자에게 보일 문구를 돌려준다. */
export async function openPersona(name: string, deps: OpenPersonaDeps): Promise<OpenPersonaResult> {
  if (!isValidPersonaName(name)) {
    return { ok: false, message: `인격 이름은 소문자·숫자·_·- 1~32자여야 합니다: ${name}` };
  }
  const dir = deps.dir ?? personasDir();
  const clock = deps.clock ?? (() => new Date());
  const loaded = await loadProfile(name, dir);
  if (!loaded.ok) {
    if (loaded.reason === "missing") {
      return { ok: false, message: await missingMessage(name, dir) };
    }
    const issues = loaded.issues.map((issue) => `- ${issue.path}: ${issue.message}`);
    return { ok: false, message: [`인격 파일 형식 오류 (${profilePath(name, dir)}):`, ...issues].join("\n") };
  }
  const { state, warning } = await loadMood(name, clock(), dir);
  if (warning !== undefined) {
    deps.onWarning(warning);
  }
  const memories = await loadMemories(name, dir);
  if (memories.warning !== undefined) {
    deps.onWarning(memories.warning);
  }
  let experiences: readonly Experience[] = memories.file.experiences;
  // 기록기와 런타임이 서로를 참조하므로, 기록기의 moodContext는 런타임이 만들어진 뒤에 읽는다.
  let runtime: PersonaRuntime | undefined;
  const recorder = createMemoryRecorder({
    profile: loaded.profile,
    initialFile: memories.file,
    readMessages: deps.readMessages ?? ((sessionId, cwd) => getSessionMessages(sessionId, { dir: cwd })),
    model: createRecordModel(deps.queryFn, deps.env),
    save: (file) => saveMemories(name, file, dir),
    moodContext: () => runtime?.moodContext() ?? { reasons: [], markers: [] },
    clock,
    onCost: deps.onCost,
    onWarning: deps.onWarning,
    onChange: (file) => {
      experiences = file.experiences;
    },
  });
  runtime = createPersonaRuntime({
    profile: loaded.profile,
    initialState: state,
    saveMood: (next) => saveMood(name, next, dir),
    signalSources: createSystemSignalSources,
    judge: createReactionJudge(deps.queryFn, deps.env, deps.onCost),
    clock,
    onWarning: deps.onWarning,
    memory: { recorder, startup: selectStartupMemories(memories.file.experiences), experiences: () => experiences },
  });
  // 지난 실행에서 기록하지 못한 구간(비정상 종료·종료 직전 등)을 백그라운드로 따라잡는다.
  void recorder.catchUp();
  return { ok: true, runtime };
}
