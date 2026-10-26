import { Box, Static, Text, useStdout } from "ink";
import { useMemo } from "react";
import { formatToolDiff } from "../../diffView.js";
import { renderMarkdownLine } from "../../markdown.js";
import { HISTORY_HEADER } from "../plain.js";
import { columnsOf } from "./terminalSize.js";
import type { NoticeItem, RunningTool, StreamingText, ToolItem, TranscriptItem, TranscriptState } from "./transcript.js";

function UserView({ text }: { text: string }) {
  return (
    <Text>
      <Text dimColor>{"> "}</Text>
      {text}
    </Text>
  );
}

function ToolView({ item }: { item: ToolItem }) {
  const { stdout } = useStdout();
  const width = columnsOf(stdout);
  const diff = useMemo(() => formatToolDiff(item.name, item.input, { width }), [item.name, item.input, width]);
  return (
    <Box flexDirection="column">
      <Text>
        ⏺ {item.name}({item.summary})
      </Text>
      {diff === undefined ? null : <Text>{diff}</Text>}
    </Box>
  );
}

function NoticeView({ item }: { item: NoticeItem }) {
  return (
    <Text color={item.tone === "error" ? "red" : undefined} dimColor={item.tone === "dim"}>
      {item.text}
    </Text>
  );
}

function HistoryView({ text }: { text: string }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{HISTORY_HEADER}</Text>
      <Text>{text}</Text>
    </Box>
  );
}

function ItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <UserView text={item.text} />;
    case "assistant":
      return <Text>{item.text}</Text>;
    case "tool":
      return <ToolView item={item} />;
    case "notice":
      return <NoticeView item={item} />;
    case "history":
      return <HistoryView text={item.text} />;
  }
}

/** 같은 응답의 이어지는 줄과 도구 오류 줄은 빈 줄 없이 앞 항목에 붙인다. */
function isAttached(item: TranscriptItem): boolean {
  return (item.kind === "assistant" || item.kind === "notice") && item.attached === true;
}

/** 실행 중 표시. 여럿이면 첫 도구와 나머지 개수만 보인다. */
function RunningToolsView({ tools }: { tools: readonly RunningTool[] }) {
  const [first] = tools;
  const others = tools.length > 1 ? ` 외 ${tools.length - 1}개` : "";
  return (
    <Text dimColor wrap="truncate">
      ⏺ {first?.name}({first?.summary}) 실행 중…{others}
    </Text>
  );
}

/** 아직 줄바꿈이 오지 않은 응답의 마지막 줄. 폭을 넘으면 방금 들어온 끝부분이 보이도록 앞을 자른다. */
function PendingLineView({ stream }: { stream: StreamingText }) {
  return <Text wrap="truncate-start">{renderMarkdownLine(stream.pending, { inCodeBlock: stream.inCodeBlock })}</Text>;
}

/** 대화와 입력창 사이의 한 줄. 진행 중 응답 줄, 실행 중 도구, 빈 줄 순으로 하나만 보인다. */
function ActivityLine({ state }: { state: TranscriptState }) {
  const { streaming, running } = state;
  if (streaming !== undefined && streaming.pending !== "") {
    return <PendingLineView stream={streaming} />;
  }
  if (running.length > 0) {
    return <RunningToolsView tools={running} />;
  }
  return <Text> </Text>;
}

/**
 * 확정 항목은 Static으로 한 번만 그리고, 그 아래 진행 표시 줄 하나만 다시 그린다.
 * 진행 표시 줄은 늘 한 줄이라 응답이 나오는 동안에도 입력창과 상태 줄이 위아래로 움직이지 않는다.
 * 동적 영역이 터미널 높이를 넘으면 Ink가 매 프레임 전체를 다시 써서 scrollback에 사본이 쌓이므로 이렇게 작게 유지한다.
 */
export function Transcript({ state }: { state: TranscriptState }) {
  return (
    <>
      <Static items={state.done}>
        {(item) => (
          <Box key={item.id} marginTop={isAttached(item) ? 0 : 1}>
            <ItemView item={item} />
          </Box>
        )}
      </Static>
      <Box marginTop={1}>
        <ActivityLine state={state} />
      </Box>
    </>
  );
}
