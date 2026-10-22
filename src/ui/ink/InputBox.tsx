import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { HISTORY_SIZE } from "../../inputHistory.js";
import { MultilineBuffer } from "../plain.js";

const PROMPT = "> ";
const CONTINUATION_PROMPT = "… ";

export interface InputBoxProps {
  /** false면 키를 받지 않고 커서도 그리지 않는다(대화상자가 떠 있을 때). */
  isActive: boolean;
  /** 첫 항목이 가장 최근 입력. */
  initialHistory: readonly string[];
  onSubmit: (text: string) => void;
  /** 여러 줄 입력 중이 아닐 때 Ctrl+C. */
  onInterrupt: () => void;
  onHistoryChange?: (history: string[]) => void;
}

/** 입력 중인 줄. 전각 문자·이모지가 한 칸씩 움직이도록 코드 포인트 배열로 다룬다. */
interface EditLine {
  chars: string[];
  cursor: number;
}

const EMPTY_LINE: EditLine = { chars: [], cursor: 0 };

function lineOf(text: string): EditLine {
  const chars = Array.from(text);
  return { chars, cursor: chars.length };
}

function insertText(line: EditLine, text: string): EditLine {
  // 대괄호 붙여넣기가 아닌 붙여넣기는 줄바꿈이 \r로 들어온다.
  const inserted = Array.from(text.replace(/\r\n?/g, "\n"));
  return {
    chars: [...line.chars.slice(0, line.cursor), ...inserted, ...line.chars.slice(line.cursor)],
    cursor: line.cursor + inserted.length,
  };
}

function deleteBackward(line: EditLine): EditLine {
  if (line.cursor === 0) {
    return line;
  }
  return {
    chars: [...line.chars.slice(0, line.cursor - 1), ...line.chars.slice(line.cursor)],
    cursor: line.cursor - 1,
  };
}

function deleteForward(line: EditLine): EditLine {
  return { chars: [...line.chars.slice(0, line.cursor), ...line.chars.slice(line.cursor + 1)], cursor: line.cursor };
}

function moveCursor(line: EditLine, cursor: number): EditLine {
  return { ...line, cursor: Math.min(Math.max(cursor, 0), line.chars.length) };
}

/** 프롬프트 입력창. 줄 끝 \\ + Enter로 여러 줄을 이어 받고, ↑/↓로 입력 기록을 오간다. */
export function InputBox({ isActive, initialHistory, onSubmit, onInterrupt, onHistoryChange }: InputBoxProps) {
  const multiline = useRef(new MultilineBuffer()).current;
  const [line, setLine] = useState<EditLine>(EMPTY_LINE);
  const [collectedLines, setCollectedLines] = useState<string[]>([]);
  const [history, setHistory] = useState<readonly string[]>(initialHistory);
  // -1은 기록이 아닌 지금 쓰는 줄(draft)을 보고 있다는 뜻이다.
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");

  const showHistoryEntry = (index: number): void => {
    setHistoryIndex(index);
    setLine(lineOf(index === -1 ? draft : (history[index] ?? "")));
  };

  // readline처럼 빈 줄과 직전과 같은 줄은 기록하지 않는다. 기록 파일은 줄 단위라 줄바꿈이 든 붙여넣기도 뺀다.
  const recordHistory = (text: string): void => {
    if (text === "" || text.includes("\n") || text === history[0]) {
      return;
    }
    const next = [text, ...history].slice(0, HISTORY_SIZE);
    setHistory(next);
    onHistoryChange?.(next);
  };

  const submitLine = (): void => {
    const text = line.chars.join("");
    recordHistory(text);
    setLine(EMPTY_LINE);
    setHistoryIndex(-1);
    setDraft("");
    const completed = multiline.push(text);
    if (completed === undefined) {
      setCollectedLines((lines) => [...lines, text]);
      return;
    }
    setCollectedLines([]);
    onSubmit(completed);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (multiline.isCollecting) {
          multiline.reset();
          setCollectedLines([]);
          setLine(EMPTY_LINE);
          return;
        }
        onInterrupt();
        return;
      }
      if (key.return) {
        submitLine();
      } else if (key.upArrow) {
        if (historyIndex + 1 < history.length) {
          if (historyIndex === -1) {
            setDraft(line.chars.join(""));
          }
          showHistoryEntry(historyIndex + 1);
        }
      } else if (key.downArrow) {
        if (historyIndex >= 0) {
          showHistoryEntry(historyIndex - 1);
        }
      } else if (key.leftArrow) {
        setLine(moveCursor(line, line.cursor - 1));
      } else if (key.rightArrow) {
        setLine(moveCursor(line, line.cursor + 1));
      } else if (key.home || (key.ctrl && input === "a")) {
        setLine(moveCursor(line, 0));
      } else if (key.end || (key.ctrl && input === "e")) {
        setLine(moveCursor(line, line.chars.length));
      } else if (key.ctrl && input === "u") {
        setLine({ chars: line.chars.slice(line.cursor), cursor: 0 });
      } else if (key.backspace) {
        setLine(deleteBackward(line));
      } else if (key.delete) {
        setLine(deleteForward(line));
      } else if (!key.ctrl && !key.meta && !key.escape && !key.tab && input !== "") {
        setLine(insertText(line, input));
      }
    },
    { isActive },
  );

  const before = line.chars.slice(0, line.cursor).join("");
  const atCursor = line.chars[line.cursor];
  const after = line.chars.slice(line.cursor + 1).join("");
  // 줄바꿈 위에 커서가 있으면 빈칸에 커서를 그리고 줄바꿈은 그대로 둔다.
  const cursorChar = atCursor === undefined || atCursor === "\n" ? " " : atCursor;
  const rest = atCursor === "\n" ? `\n${after}` : after;

  return (
    <Box flexDirection="column">
      {collectedLines.map((collected, index) => (
        <Text key={index}>
          <Text dimColor>{index === 0 ? PROMPT : CONTINUATION_PROMPT}</Text>
          {collected}
        </Text>
      ))}
      <Text>
        <Text dimColor>{collectedLines.length === 0 ? PROMPT : CONTINUATION_PROMPT}</Text>
        {isActive ? (
          <>
            {before}
            <Text inverse>{cursorChar}</Text>
            {rest}
          </>
        ) : (
          line.chars.join("")
        )}
      </Text>
    </Box>
  );
}
