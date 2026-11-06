import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { isWorkTime } from "./mood.js";
import type { MoodEvent, MoodState } from "./mood.js";
import type { PersonaProfile } from "./profile.js";
import { BREAK_MS, CPU_BUSY_RATIO, MEMORY_AVAILABLE_LOW } from "./tuning.js";

const execFileAsync = promisify(execFile);
const SATURDAY = 6;
const SUNDAY = 0;

/** 시간·시스템 신호의 출처. 테스트에서 가짜로 바꾼다. */
export interface SignalSources {
  now: Date;
  /** 메모리 여유율(%). 읽지 못하면 undefined. */
  readMemoryAvailablePercent: () => Promise<number | undefined>;
  loadAverage1m: number;
  cpuCount: number;
}

/** `sysctl -n kern.memorystatus_level` 출력(여유율 %)을 읽는다. */
export function parseMemoryStatusLevel(stdout: string): number | undefined {
  const value = Number(stdout.trim());
  return stdout.trim() !== "" && Number.isFinite(value) ? value : undefined;
}

/**
 * macOS의 os.freemem()은 캐시를 사용 중으로 쳐서 항상 90%대 사용률로 나온다.
 * 그래서 darwin에서는 커널의 메모리 여유율을 읽고, 그 밖의 OS에서만 os 값을 쓴다.
 */
async function readMemoryAvailablePercent(): Promise<number | undefined> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("sysctl", ["-n", "kern.memorystatus_level"]);
      return parseMemoryStatusLevel(stdout);
    } catch {
      return undefined;
    }
  }
  return (freemem() / totalmem()) * 100;
}

export function createSystemSignalSources(now: Date): SignalSources {
  return {
    now,
    readMemoryAvailablePercent,
    loadAverage1m: loadavg()[0] ?? 0,
    cpuCount: Math.max(1, cpus().length),
  };
}

/**
 * 시간·시스템 신호. state는 감쇠 전 상태여야 한다(updatedAt으로 쉰 시간을 잰다).
 * isFirstPromptOfSession이면 주말 출근 신호를 한 번 낸다.
 */
export async function signalEvents(
  state: MoodState,
  profile: PersonaProfile,
  sources: SignalSources,
  isFirstPromptOfSession: boolean,
): Promise<MoodEvent[]> {
  const { now } = sources;
  const events: MoodEvent[] = [];
  if (now.getTime() - Date.parse(state.updatedAt) > BREAK_MS) {
    events.push({ kind: "returnAfterBreak" });
  }
  const day = now.getDay();
  if (isFirstPromptOfSession && (day === SATURDAY || day === SUNDAY)) {
    events.push({ kind: "weekendStart" });
  }
  if (profile.workHours !== null && !isWorkTime(profile.workHours, now)) {
    events.push({ kind: "afterHours" });
  }
  const memoryAvailable = await sources.readMemoryAvailablePercent();
  if (memoryAvailable !== undefined && memoryAvailable < MEMORY_AVAILABLE_LOW) {
    events.push({ kind: "memoryPressure" });
  }
  if (sources.loadAverage1m / sources.cpuCount > CPU_BUSY_RATIO) {
    events.push({ kind: "cpuBusy" });
  }
  return events;
}
