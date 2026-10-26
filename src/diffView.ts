import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { styleText } from "node:util";
import { diffLines } from "diff";
import stringWidth from "string-width";

export const DIFF_MAX_LINES = 40;

const INDENT = "    ";
const CONTEXT_LINES = 2;

// 파스텔 배경(256색 연두 194·분홍 224)에 진한 글자(초록 22·빨강 88). 밝은·어두운 테마 어디서나 배경과 글자가 대비된다.
const ADDED_STYLE = "\u001b[48;5;194m\u001b[38;5;22m";
const REMOVED_STYLE = "\u001b[48;5;224m\u001b[38;5;88m";
const RESET_STYLE = "\u001b[49m\u001b[39m";

export interface DiffFormatOptions {
  /** 터미널 폭. 주면 바뀐 줄의 배경을 줄 맨 앞부터 그 폭 끝까지 채운다. */
  width?: number;
}

/** styleText가 색을 내보내는 환경인지. NO_COLOR이거나 터미널이 아닌 출력이면 false. */
function colorsEnabled(): boolean {
  return styleText("red", "x") !== "x";
}

/** 바뀐 줄(들여쓰기 포함)에 배경과 글자색을 입힌다. width를 알면 공백으로 채워 배경을 줄 끝까지 이어 준다. */
function withStyle(style: string, text: string, width: number | undefined): string {
  if (!colorsEnabled()) {
    return text;
  }
  const padding = width === undefined ? "" : " ".repeat(Math.max(0, width - stringWidth(text)));
  return `${style}${text}${padding}${RESET_STYLE}`;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function removedLine(line: string, width: number | undefined): string {
  return withStyle(REMOVED_STYLE, `${INDENT}- ${line}`, width);
}

function addedLine(line: string, width: number | undefined): string {
  return withStyle(ADDED_STYLE, `${INDENT}+ ${line}`, width);
}

function contextLine(line: string): string {
  return `${INDENT}${styleText("dim", `  ${line}`)}`;
}

/** 바뀌지 않은 구간에서 인접한 변경 쪽 CONTEXT_LINES줄만 남긴다. */
function trimContext(lines: string[], hasChangeBefore: boolean, hasChangeAfter: boolean): string[] {
  if (hasChangeBefore && hasChangeAfter && lines.length <= CONTEXT_LINES * 2) {
    return lines;
  }
  const afterPreviousChange = hasChangeBefore ? lines.slice(0, CONTEXT_LINES) : [];
  const beforeNextChange = hasChangeAfter ? lines.slice(-CONTEXT_LINES) : [];
  return [...afterPreviousChange, ...beforeNextChange];
}

function formatEdit(oldString: string, newString: string, replaceAll: boolean, lineWidth: number | undefined): string[] {
  const parts = diffLines(oldString, newString);
  const output: string[] = replaceAll ? [`${INDENT}${styleText("dim", "(모든 위치 바꿈)")}`] : [];

  parts.forEach((part, index) => {
    const lines = splitLines(part.value);
    if (part.added) {
      output.push(...lines.map((line) => addedLine(line, lineWidth)));
    } else if (part.removed) {
      output.push(...lines.map((line) => removedLine(line, lineWidth)));
    } else {
      const trimmed = trimContext(lines, index > 0, index < parts.length - 1);
      output.push(...trimmed.map(contextLine));
    }
  });
  return output;
}

function limitLines(lines: string[]): string[] {
  if (lines.length <= DIFF_MAX_LINES) {
    return lines;
  }
  return [...lines.slice(0, DIFF_MAX_LINES), `${INDENT}${styleText("dim", `… ${lines.length - DIFF_MAX_LINES}줄 더`)}`];
}

/** Edit·Write 도구 입력을 색칠한 diff 문자열로 만든다. 대상이 아니면 undefined. */
export function formatToolDiff(
  toolName: string,
  input: Record<string, unknown>,
  options: DiffFormatOptions = {},
): string | undefined {
  const lineWidth = options.width;
  let lines: string[];

  if (toolName === "Edit") {
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return undefined;
    }
    lines = formatEdit(oldString, newString, replaceAll === true, lineWidth);
  } else if (toolName === "Write") {
    const { content } = input;
    if (typeof content !== "string") {
      return undefined;
    }
    lines = splitLines(content).map((line) => addedLine(line, lineWidth));
  } else {
    return undefined;
  }

  return limitLines(lines).join("\n");
}

export interface DiffSummaryOptions {
  /** 경로를 이 디렉터리 기준 상대 경로로 보인다. */
  cwd?: string;
  /** 파일 내용. 없거나 읽지 못하면 undefined. 테스트에서 바꿔 넣는다. */
  readFile?: (path: string) => string | undefined;
}

interface LineChange {
  kind: "삭제" | "추가";
  /** 알면 파일에서의 시작 행(1부터). */
  line?: number;
  count: number;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  return relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath) ? path : relativePath;
}

/** text가 content에서 시작하는 행(1부터). 없으면 undefined. */
function lineNumberOf(content: string, text: string): number | undefined {
  const index = text === "" ? -1 : content.indexOf(text);
  return index === -1 ? undefined : content.slice(0, index).split("\n").length;
}

/** Edit의 바뀐 구간마다 시작 행과 줄 수. startLine을 모르면 행 없이 줄 수만. */
function editChanges(oldString: string, newString: string, startLine: number | undefined): LineChange[] {
  const changes: LineChange[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  for (const part of diffLines(oldString, newString)) {
    const count = splitLines(part.value).length;
    if (part.added) {
      changes.push({ kind: "추가", count, ...(startLine === undefined ? {} : { line: startLine + newOffset }) });
      newOffset += count;
    } else if (part.removed) {
      changes.push({ kind: "삭제", count, ...(startLine === undefined ? {} : { line: startLine + oldOffset }) });
      oldOffset += count;
    } else {
      oldOffset += count;
      newOffset += count;
    }
  }
  return changes;
}

function formatChange({ kind, line, count }: LineChange): string {
  return line === undefined ? `${count}줄 ${kind}` : `${line}행 ${count}줄 ${kind}`;
}

function formatChanges(changes: readonly LineChange[]): string {
  return changes.length === 0 ? "변경 없음" : changes.map(formatChange).join(", ");
}

/**
 * diff 아래에 보일 한 줄 요약: `⎿ 경로 · 13행 1줄 삭제, 13행 2줄 추가`.
 * Edit 입력에는 행 번호가 없으므로 파일에서 바꿀 문자열(이미 적용됐으면 새 문자열)의 위치로 찾는다.
 */
export function formatDiffSummary(
  toolName: string,
  input: Record<string, unknown>,
  { cwd = process.cwd(), readFile = readTextFile }: DiffSummaryOptions = {},
): string | undefined {
  const { file_path: filePath } = input;
  if (typeof filePath !== "string") {
    return undefined;
  }
  const path = displayPath(filePath, cwd);

  if (toolName === "Edit") {
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return undefined;
    }
    if (replaceAll === true) {
      return `⎿ ${path} · 모든 위치 바꿈: ${formatChanges(editChanges(oldString, newString, undefined))}`;
    }
    const content = readFile(filePath);
    const startLine =
      content === undefined ? undefined : (lineNumberOf(content, oldString) ?? lineNumberOf(content, newString));
    return `⎿ ${path} · ${formatChanges(editChanges(oldString, newString, startLine))}`;
  }

  if (toolName === "Write") {
    const { content } = input;
    if (typeof content !== "string") {
      return undefined;
    }
    const lineCount = splitLines(content).length;
    return readFile(filePath) === undefined
      ? `⎿ ${path} · 새 파일 ${lineCount}줄`
      : `⎿ ${path} · 파일 전체 ${lineCount}줄로 바꿈`;
  }
  return undefined;
}
