import { Text } from "ink";
import { formatStatusLine } from "../plain.js";

export type StatusBarProps = Parameters<typeof formatStatusLine>[0];

/** 하단 상태 줄. 터미널 폭을 넘으면 줄바꿈하지 않고 자른다. */
export function StatusBar(props: StatusBarProps) {
  return <Text wrap="truncate">{formatStatusLine(props)}</Text>;
}
