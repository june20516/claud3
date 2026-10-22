import { Box, Static, Text } from "ink";
import { useMemo } from "react";
import { formatToolDiff } from "../../diffView.js";
import { renderMarkdownLine } from "../../markdown.js";
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
  const diff = useMemo(() => formatToolDiff(item.name, item.input), [item.name, item.input]);
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
  }
}

/** 같은 응답의 이어지는 줄과 도구 오류 줄은 빈 줄 없이 앞 항목에 붙인다. */
function isAttached(item: TranscriptItem): boolean {
  return (item.kind === "assistant" || item.kind === "notice") && item.attached === true;
}

/** 실행 중 표시. 폭을 넘어도 한 줄을 지키도록 자른다. */
function RunningToolView({ tool }: { tool: RunningTool }) {
  return (
    <Text dimColor wrap="truncate">
      ⏺ {tool.name}({tool.summary}) 실행 중…
    </Text>
  );
}

/** 아직 줄바꿈이 오지 않은 응답의 마지막 줄. */
function PendingLineView({ stream }: { stream: StreamingText }) {
  return <Text>{renderMarkdownLine(stream.pending, { inCodeBlock: stream.inCodeBlock })}</Text>;
}

/**
 * 확정 항목은 Static으로 한 번만 그리고, 실행 중 표시와 진행 중 응답의 마지막 줄만 다시 그린다.
 * 동적 영역이 터미널 높이를 넘으면 Ink가 매 프레임 전체를 다시 써서 scrollback에 사본이 쌓이므로 작게 유지한다.
 */
export function Transcript({ state }: { state: TranscriptState }) {
  const { streaming } = state;
  return (
    <>
      <Static items={state.done}>
        {(item) => (
          <Box key={item.id} marginTop={isAttached(item) ? 0 : 1}>
            <ItemView item={item} />
          </Box>
        )}
      </Static>
      {state.running.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          {state.running.map((tool) => (
            <RunningToolView key={tool.toolUseId} tool={tool} />
          ))}
        </Box>
      )}
      {streaming === undefined || streaming.pending === "" ? null : (
        <Box marginTop={streaming.started ? 0 : 1}>
          <PendingLineView stream={streaming} />
        </Box>
      )}
    </>
  );
}
