import { Box, Text, useInput } from "ink";
import { useReducer, useRef } from "react";
import { formatSessionTime } from "../../sessionList.js";
import type { SessionListItem } from "../../sessionList.js";

/** 한 번에 보일 세션 수. 세션 하나가 두 줄(제목, 시간)이다. */
const VISIBLE_COUNT = 8;

export interface SessionPickerProps {
  /** 최신순. */
  items: readonly SessionListItem[];
  onPick: (sessionId: string) => void;
  onCancel: () => void;
}

/** 고른 항목이 창 가운데쯤 오도록 보일 범위의 시작 위치를 정한다. */
function windowStart(selected: number, total: number): number {
  const centered = selected - Math.floor(VISIBLE_COUNT / 2);
  return Math.min(Math.max(centered, 0), Math.max(total - VISIBLE_COUNT, 0));
}

/**
 * /resume 세션 목록. ↑/↓로 고르고 Enter로 열며 Esc는 취소한다.
 * Ctrl+C(취소)는 App이 처리한다.
 */
export function SessionPicker({ items, onPick, onCancel }: SessionPickerProps) {
  // 한 청크의 여러 키가 렌더 없이 연달아 오므로 선택은 ref에서 읽고 바꾼다.
  const selectedRef = useRef(0);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  // 목록을 여는 동안 "n분 전"이 흔들리지 않도록 기준 시각을 고정한다.
  const now = useRef(Date.now()).current;

  const select = (index: number): void => {
    selectedRef.current = Math.min(Math.max(index, 0), items.length - 1);
    rerender();
  };

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow) {
      select(selectedRef.current - 1);
    } else if (key.downArrow) {
      select(selectedRef.current + 1);
    } else if (key.return) {
      const item = items[selectedRef.current];
      if (item !== undefined) {
        onPick(item.sessionId);
      }
    }
  });

  const selected = selectedRef.current;
  const start = windowStart(selected, items.length);
  const visible = items.slice(start, start + VISIBLE_COUNT);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        이어서 열 세션 (최신순) {selected + 1}/{items.length}
      </Text>
      {visible.map((item, offset) => {
        const isSelected = start + offset === selected;
        return (
          <Box key={item.sessionId} flexDirection="column">
            <Text color={isSelected ? "cyan" : undefined} wrap="truncate">
              {isSelected ? "❯ " : "  "}
              {item.title}
            </Text>
            <Text dimColor>
              {"    "}
              {formatSessionTime(item.lastModified, now)}
            </Text>
          </Box>
        );
      })}
      <Text dimColor>↑/↓ 이동 · Enter 열기 · Esc 취소</Text>
    </Box>
  );
}
