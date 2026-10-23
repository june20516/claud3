const DEFAULT_COLUMNS = 80;

/** 터미널 폭. 터미널이 아닌 스트림(테스트 등)이면 기본값. */
export function columnsOf(stream: NodeJS.WritableStream): number {
  return "columns" in stream && typeof stream.columns === "number" ? stream.columns : DEFAULT_COLUMNS;
}
