import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../usageStore.js";
import { initialMood, parseMoodState } from "./mood.js";
import type { MoodState } from "./mood.js";
import { validateProfile } from "./profile.js";
import type { PersonaProfile, ValidationIssue } from "./profile.js";

const PROFILE_SUFFIX = ".json";
const MOOD_SUFFIX = ".mood.json";
const BROKEN_MOOD_WARNING = "기분 파일이 깨져 새로 시작합니다";

export type ProfileLoadResult =
  | { ok: true; profile: PersonaProfile }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid"; issues: ValidationIssue[] };

export function personasDir(): string {
  return join(configDir(), "personas");
}

export function profilePath(name: string, dir: string = personasDir()): string {
  return join(dir, `${name}${PROFILE_SUFFIX}`);
}

function moodPath(name: string, dir: string): string {
  return join(dir, `${name}${MOOD_SUFFIX}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 임시 파일에 쓰고 rename해 중간에 끊겨도 반쯤 쓴 파일이 남지 않게 한다. */
async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

export async function listPersonas(dir: string = personasDir()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(PROFILE_SUFFIX) && !entry.endsWith(MOOD_SUFFIX))
    .map((entry) => entry.slice(0, -PROFILE_SUFFIX.length))
    .sort();
}

export async function loadProfile(name: string, dir: string = personasDir()): Promise<ProfileLoadResult> {
  let raw: string;
  try {
    raw = await readFile(profilePath(name, dir), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { ok: false, reason: "missing" };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid", issues: [{ path: "", message: `JSON 형식 오류: ${message}` }] };
  }
  const result = validateProfile(parsed);
  return result.ok ? result : { ok: false, reason: "invalid", issues: result.issues };
}

export async function saveProfile(profile: PersonaProfile, dir: string = personasDir()): Promise<string> {
  const filePath = profilePath(profile.name, dir);
  await writeJsonAtomically(filePath, profile);
  return filePath;
}

/** 기분 파일이 없으면 초기 상태, 깨졌으면 .broken으로 옮기고 경고와 함께 초기 상태. */
export async function loadMood(
  name: string,
  now: Date,
  dir: string = personasDir(),
): Promise<{ state: MoodState; warning?: string }> {
  const filePath = moodPath(name, dir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { state: initialMood(now) };
    }
    throw error;
  }
  let state: MoodState | undefined;
  try {
    state = parseMoodState(JSON.parse(raw));
  } catch {
    state = undefined;
  }
  if (state !== undefined) {
    return { state };
  }
  await rename(filePath, `${filePath}.broken`);
  return { state: initialMood(now), warning: BROKEN_MOOD_WARNING };
}

export async function saveMood(name: string, state: MoodState, dir: string = personasDir()): Promise<void> {
  await writeJsonAtomically(moodPath(name, dir), state);
}
