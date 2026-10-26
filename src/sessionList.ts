import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ListSessionsOptions, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

/** 고를 수 있게 보일 최대 세션 수. */
export const SESSION_LIST_LIMIT = 50;

const UNTITLED = "(제목 없음)";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** resume 목록의 한 줄. */
export interface SessionListItem {
  sessionId: string;
  /** 직접 지은 제목, 자동 요약, 첫 프롬프트 중 SDK가 고른 것의 첫 줄. */
  title: string;
  /** 마지막 대화 시간(ms). */
  lastModified: number;
}

export type SessionLister = (options: ListSessionsOptions) => Promise<SDKSessionInfo[]>;

function titleOf(summary: string): string {
  const firstLine = summary.trim().split("\n")[0]?.trim() ?? "";
  return firstLine === "" ? UNTITLED : firstLine;
}

/** cwd 프로젝트의 세션을 최신순으로 읽는다. 지금 열린 세션은 뺀다. */
export async function loadSessionList({
  cwd,
  excludeSessionId,
  lister = listSessions,
}: {
  cwd: string;
  excludeSessionId?: string;
  lister?: SessionLister;
}): Promise<SessionListItem[]> {
  const sessions = await lister({ dir: cwd, limit: SESSION_LIST_LIMIT });
  return sessions
    .filter((session) => session.sessionId !== excludeSessionId)
    .map((session) => ({ sessionId: session.sessionId, title: titleOf(session.summary), lastModified: session.lastModified }))
    .sort((a, b) => b.lastModified - a.lastModified);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function elapsedText(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) {
    return "방금";
  }
  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)}분 전`;
  }
  if (elapsedMs < DAY_MS) {
    return `${Math.floor(elapsedMs / HOUR_MS)}시간 전`;
  }
  return `${Math.floor(elapsedMs / DAY_MS)}일 전`;
}

/** `10/26 14:03 · 3분 전`. 올해가 아니면 연도를 앞에 붙인다. 시각은 로컬 시간대다. */
export function formatSessionTime(lastModified: number, now: number = Date.now()): string {
  const date = new Date(lastModified);
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : `${date.getFullYear()}/`;
  const stamp = `${year}${date.getMonth() + 1}/${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  return `${stamp} · ${elapsedText(Math.max(now - lastModified, 0))}`;
}
