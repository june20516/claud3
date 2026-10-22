import { Box, Static, Text, useStdout } from "ink";
import { useMemo } from "react";
import { formatToolDiff } from "../../diffView.js";
import { createMarkdownRenderer } from "../../markdown.js";
import type { AssistantItem, NoticeItem, ToolItem, TranscriptItem, TranscriptState } from "./transcript.js";

/** 입력창·대화상자·상태 줄이 쓸 줄 수. 진행 중 응답은 남은 높이만큼만 보인다. */
const RESERVED_ROWS = 10;
const MIN_STREAMING_ROWS = 5;

function renderMarkdown(text: string): string {
  const renderer = createMarkdownRenderer();
  return `${renderer.push(text)}${renderer.flush()}`.replace(/\n+$/, "");
}

/** 긴 응답이 화면을 넘어 입력창을 밀어내지 않도록 끝쪽 maxLines줄만 남긴다. */
function lastLines(text: string, maxLines: number | undefined): string {
  if (maxLines === undefined) {
    return text;
  }
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

function UserView({ text }: { text: string }) {
  return (
    <Text>
      <Text dimColor>{"> "}</Text>
      {text}
    </Text>
  );
}

function AssistantView({ item, maxLines }: { item: AssistantItem; maxLines?: number }) {
  const rendered = useMemo(() => renderMarkdown(item.text), [item.text]);
  return <Text>{lastLines(rendered, maxLines)}</Text>;
}

function ToolView({ item }: { item: ToolItem }) {
  const diff = useMemo(() => formatToolDiff(item.name, item.input), [item.name, item.input]);
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor={item.status === "running"}>⏺</Text> {item.name}({item.summary})
      </Text>
      {diff === undefined ? null : <Text>{diff}</Text>}
      {item.status === "error" ? <Text color="red">{`  ⎿ ${item.errorSummary ?? ""}`}</Text> : null}
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

function ItemView({ item, maxLines }: { item: TranscriptItem; maxLines?: number }) {
  switch (item.kind) {
    case "user":
      return <UserView text={item.text} />;
    case "assistant":
      return <AssistantView item={item} maxLines={maxLines} />;
    case "tool":
      return <ToolView item={item} />;
    case "notice":
      return <NoticeView item={item} />;
  }
}

/** 확정 항목은 Static으로 한 번만 그리고, 실행 중인 도구와 진행 중 응답만 다시 그린다. */
export function Transcript({ state }: { state: TranscriptState }) {
  const { stdout } = useStdout();
  // 테스트용 스트림처럼 TTY가 아니면 rows가 없다.
  const rows = "rows" in stdout && typeof stdout.rows === "number" ? stdout.rows : undefined;
  const streamingRows = rows === undefined ? undefined : Math.max(rows - RESERVED_ROWS, MIN_STREAMING_ROWS);
  return (
    <>
      <Static items={state.done}>
        {(item) => (
          <Box key={item.id} marginTop={1}>
            <ItemView item={item} />
          </Box>
        )}
      </Static>
      {state.running.map((tool) => (
        <Box key={tool.id} marginTop={1}>
          <ItemView item={tool} />
        </Box>
      ))}
      {state.streaming === undefined ? null : (
        <Box marginTop={1}>
          <ItemView item={state.streaming} maxLines={streamingRows} />
        </Box>
      )}
    </>
  );
}
