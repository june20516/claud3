import {
  FEELING_MAX,
  MEMORY_LIMIT,
  MEMORY_SESSION_LIMIT,
  SESSION_STALE_DAYS,
  SUMMARY_MAX,
} from "../tuning.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Importance = 1 | 2 | 3;

/** 인격이 기억하는 일 하나. 근거(세션·기분 변화)를 함께 둔다. */
export interface Experience {
  id: string;
  summary: string;
  /** 인격의 말투로 쓴 한 줄 소감. */
  feeling: string;
  importance: Importance;
  at: string;
  sessionId: string;
  moodReasons: string[];
  moodDelta: { stress: number; dopamine: number };
}

/** 이 인격이 켜졌던 세션과 기록 커서. */
export interface TrackedSession {
  sessionId: string;
  cwd: string;
  /** 마지막으로 기록에 넣은 메시지 uuid. 처음엔 null. */
  cursor: string | null;
  /** 현재 구간의 연속 실패 횟수. */
  failures: number;
  lastSeenAt: string;
  lastReadAt: string | null;
  /** 등록 시각으로 시작해 기록에 성공할 때마다 기록 시각. 구간 시간대의 시작이다. */
  recordedUntil: string;
}

export interface MemoryFile {
  version: 1;
  experiences: Experience[];
  sessions: TrackedSession[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isImportance(value: unknown): value is Importance {
  return value === 1 || value === 2 || value === 3;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function emptyMemoryFile(): MemoryFile {
  return { version: 1, experiences: [], sessions: [] };
}

function parseExperience(value: unknown): Experience | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, summary, feeling, importance, at, sessionId, moodReasons, moodDelta } = value;
  if (
    typeof id !== "string" ||
    typeof summary !== "string" ||
    summary.trim() === "" ||
    typeof feeling !== "string" ||
    !isImportance(importance) ||
    !isTimestamp(at) ||
    typeof sessionId !== "string" ||
    !isStringArray(moodReasons) ||
    !isRecord(moodDelta) ||
    !isFiniteNumber(moodDelta.stress) ||
    !isFiniteNumber(moodDelta.dopamine)
  ) {
    return undefined;
  }
  return {
    id,
    summary: summary.slice(0, SUMMARY_MAX),
    feeling: feeling.slice(0, FEELING_MAX),
    importance,
    at,
    sessionId,
    moodReasons,
    moodDelta: { stress: moodDelta.stress, dopamine: moodDelta.dopamine },
  };
}

function parseSession(value: unknown): TrackedSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { sessionId, cwd, cursor, failures, lastSeenAt, lastReadAt, recordedUntil } = value;
  if (
    typeof sessionId !== "string" ||
    typeof cwd !== "string" ||
    (cursor !== null && typeof cursor !== "string") ||
    !isFiniteNumber(failures) ||
    !isTimestamp(lastSeenAt) ||
    (lastReadAt !== null && !isTimestamp(lastReadAt)) ||
    !isTimestamp(recordedUntil)
  ) {
    return undefined;
  }
  return { sessionId, cwd, cursor, failures, lastSeenAt, lastReadAt, recordedUntil };
}

/** 최상위 형식이 틀리면 undefined. 항목 하나가 깨졌으면 그 항목만 버린다. 긴 summary·feeling은 자른다. */
export function parseMemoryFile(value: unknown): MemoryFile | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.experiences) || !Array.isArray(value.sessions)) {
    return undefined;
  }
  return {
    version: 1,
    experiences: value.experiences.flatMap((item) => parseExperience(item) ?? []),
    sessions: value.sessions.flatMap((item) => parseSession(item) ?? []),
  };
}

function byTimeAscending(a: Experience, b: Experience): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/** 중요도 낮은 것 → 같은 중요도면 at이 오래된 것부터 지워 limit개 이하로. 남은 것은 at 오름차순. */
export function pruneExperiences(experiences: readonly Experience[], limit: number = MEMORY_LIMIT): Experience[] {
  const keepOrder = [...experiences].sort((a, b) => b.importance - a.importance || Date.parse(b.at) - Date.parse(a.at));
  return keepOrder.slice(0, limit).sort(byTimeAscending);
}

/** lastReadAt(없으면 lastSeenAt)이 SESSION_STALE_DAYS를 넘은 세션을 빼고, lastSeenAt 최근 순 MEMORY_SESSION_LIMIT개. */
export function trimSessions(sessions: readonly TrackedSession[], now: Date): TrackedSession[] {
  const staleBefore = now.getTime() - SESSION_STALE_DAYS * DAY_MS;
  return sessions
    .filter((session) => Date.parse(session.lastReadAt ?? session.lastSeenAt) >= staleBefore)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, MEMORY_SESSION_LIMIT);
}

/**
 * 다른 프로세스가 그사이 쓴 파일(onDisk)과 내 상태(mine)를 합친다.
 * 경험은 id 합집합(같은 id는 mine) 후 pruneExperiences.
 * 세션은 sessionId 합집합이고, 양쪽에 있으면 recordedUntil이 늦은 쪽 항목 전체를 쓴다(같으면 mine).
 * 커서 uuid만으로는 어느 쪽이 더 뒤인지 알 수 없어서 recordedUntil로 판단한다.
 */
export function mergeMemoryFiles(onDisk: MemoryFile, mine: MemoryFile): MemoryFile {
  const experiences = new Map(onDisk.experiences.map((item) => [item.id, item]));
  for (const item of mine.experiences) {
    experiences.set(item.id, item);
  }
  const sessions = new Map(onDisk.sessions.map((item) => [item.sessionId, item]));
  for (const item of mine.sessions) {
    const disk = sessions.get(item.sessionId);
    if (disk === undefined || Date.parse(item.recordedUntil) >= Date.parse(disk.recordedUntil)) {
      sessions.set(item.sessionId, item);
    }
  }
  return { version: 1, experiences: pruneExperiences([...experiences.values()]), sessions: [...sessions.values()] };
}
