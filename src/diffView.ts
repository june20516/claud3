import { styleText } from "node:util";
import { diffLines } from "diff";
import stringWidth from "string-width";

export const DIFF_MAX_LINES = 40;

const INDENT = "    ";
const CONTEXT_LINES = 2;

// 256색 어두운 초록·빨강 배경에 밝은 글자(255). 글자를 기본색에 맡기면 밝은 테마에서 검은 글자가 배경에 묻힌다.
const ADDED_BACKGROUND = "\u001b[48;5;22m";
const REMOVED_BACKGROUND = "\u001b[48;5;52m";
const LIGHT_FOREGROUND = "\u001b[38;5;255m";
const RESET_BACKGROUND = "\u001b[49m";
const RESET_FOREGROUND = "\u001b[39m";

export interface DiffFormatOptions {
  /** 터미널 폭. 주면 바뀐 줄의 배경을 그 폭 끝까지 채운다. */
  width?: number;
}

/** styleText가 색을 내보내는 환경인지. NO_COLOR이거나 터미널이 아닌 출력이면 false. */
function colorsEnabled(): boolean {
  return styleText("red", "x") !== "x";
}

/** 바뀐 줄에 배경과 밝은 글자색을 입힌다. lineWidth를 알면 공백으로 채워 배경을 줄 끝까지 이어 준다. */
function withBackground(background: string, text: string, lineWidth: number | undefined): string {
  if (!colorsEnabled()) {
    return text;
  }
  const padding = lineWidth === undefined ? "" : " ".repeat(Math.max(0, lineWidth - stringWidth(text)));
  return `${background}${LIGHT_FOREGROUND}${text}${padding}${RESET_BACKGROUND}${RESET_FOREGROUND}`;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function removedLine(line: string, lineWidth: number | undefined): string {
  return withBackground(REMOVED_BACKGROUND, `- ${line}`, lineWidth);
}

function addedLine(line: string, lineWidth: number | undefined): string {
  return withBackground(ADDED_BACKGROUND, `+ ${line}`, lineWidth);
}

function contextLine(line: string): string {
  return styleText("dim", `  ${line}`);
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
  const output: string[] = replaceAll ? [styleText("dim", "(모든 위치 바꿈)")] : [];

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
  return [...lines.slice(0, DIFF_MAX_LINES), styleText("dim", `… ${lines.length - DIFF_MAX_LINES}줄 더`)];
}

/** Edit·Write 도구 입력을 색칠한 diff 문자열로 만든다. 대상이 아니면 undefined. */
export function formatToolDiff(
  toolName: string,
  input: Record<string, unknown>,
  options: DiffFormatOptions = {},
): string | undefined {
  const lineWidth = options.width === undefined ? undefined : options.width - INDENT.length;
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

  return limitLines(lines)
    .map((line) => `${INDENT}${line}`)
    .join("\n");
}
