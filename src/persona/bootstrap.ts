import { createReactionJudge } from "./actions.js";
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
  const runtime = createPersonaRuntime({
    profile: loaded.profile,
    initialState: state,
    saveMood: (next) => saveMood(name, next, dir),
    signalSources: createSystemSignalSources,
    judge: createReactionJudge(deps.queryFn, deps.env, deps.onCost),
    clock,
    onWarning: deps.onWarning,
  });
  return { ok: true, runtime };
}
