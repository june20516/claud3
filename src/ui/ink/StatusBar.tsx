import { Box, Text } from "ink";
import { statusLineText } from "../plain.js";
import type { StatusLineParams } from "../plain.js";

export type StatusBarProps = StatusLineParams;

// 어두운 회색 띠. 대화 영역과 구분되면서 밝은 글자가 잘 읽힌다.
const STATUS_BAR_BACKGROUND = "#303030";

/** 하단 상태 줄. 터미널 폭 전체에 배경 띠를 깔고, 폭을 넘으면 줄바꿈하지 않고 자른다. */
export function StatusBar(props: StatusBarProps) {
  return (
    <Box width="100%" backgroundColor={STATUS_BAR_BACKGROUND}>
      <Text wrap="truncate">{` ${statusLineText(props)}`}</Text>
    </Box>
  );
}
