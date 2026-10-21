import { styleText } from "node:util";
import { diffLines } from "diff";

export const DIFF_MAX_LINES = 40;

const INDENT = "    ";
const CONTEXT_LINES = 2;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function removedLine(line: string): string {
  return styleText("red", `- ${line}`);
}

function addedLine(line: string): string {
  return styleText("green", `+ ${line}`);
}

function contextLine(line: string): string {
  return styleText("dim", `  ${line}`);
}

/** 바뀌지 않은 구간에서 인접한 변경과 맞닿은 앞뒤 CONTEXT_LINES줄만 남긴다. */
function trimContext(lines: string[], hasChangeBefore: boolean, hasChangeAfter: boolean): string[] {
  const head = hasChangeBefore ? lines.slice(0, CONTEXT_LINES) : [];
  const tail = hasChangeAfter ? lines.slice(Math.max(CONTEXT_LINES, lines.length - CONTEXT_LINES)) : [];
  return lines.length <= CONTEXT_LINES * 2 && hasChangeBefore && hasChangeAfter ? lines : [...head, ...tail];
}

function formatEdit(oldString: string, newString: string, replaceAll: boolean): string[] {
  const parts = diffLines(oldString, newString);
  const output: string[] = replaceAll ? [styleText("dim", "(모든 위치 바꿈)")] : [];

  parts.forEach((part, index) => {
    const lines = splitLines(part.value);
    if (part.added) {
      output.push(...lines.map(addedLine));
    } else if (part.removed) {
      output.push(...lines.map(removedLine));
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
export function formatToolDiff(toolName: string, input: Record<string, unknown>): string | undefined {
  let lines: string[];

  if (toolName === "Edit") {
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return undefined;
    }
    lines = formatEdit(oldString, newString, replaceAll === true);
  } else if (toolName === "Write") {
    const { content } = input;
    if (typeof content !== "string") {
      return undefined;
    }
    lines = splitLines(content).map(addedLine);
  } else {
    return undefined;
  }

  return limitLines(lines)
    .map((line) => `${INDENT}${line}`)
    .join("\n");
}
