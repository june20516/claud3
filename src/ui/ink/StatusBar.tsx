import { Box, Text } from "ink";
import { statusLineText } from "../plain.js";
import type { StatusLineParams } from "../plain.js";

export type StatusBarProps = StatusLineParams;

// 어두운 회색 띠 위에 밝은 회색 글자. 글자색을 터미널 기본값에 맡기면 밝은 테마에서 배경과 구분되지 않는다.
const STATUS_BAR_BACKGROUND = "#303030";
const STATUS_BAR_FOREGROUND = "#d0d0d0";

/** 하단 상태 줄. 터미널 폭 전체에 배경 띠를 깔고, 폭을 넘으면 줄바꿈하지 않고 자른다. */
export function StatusBar(props: StatusBarProps) {
  return (
    <Box width="100%" backgroundColor={STATUS_BAR_BACKGROUND}>
      <Text color={STATUS_BAR_FOREGROUND} wrap="truncate">{` ${statusLineText(props)}`}</Text>
    </Box>
  );
}
