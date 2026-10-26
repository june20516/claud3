import { Box, Text, useStdout } from "ink";
import stringWidth from "string-width";
import type { WorkspaceInfo } from "../../workspaceInfo.js";
import { statusLineText } from "../plain.js";
import type { StatusLineParams } from "../plain.js";
import { columnsOf } from "./terminalSize.js";

export interface StatusBarProps extends StatusLineParams {
  /** 현재 디렉터리와 git 브랜치. 읽기 전이면 없다. */
  workspace?: WorkspaceInfo;
}

// 어두운 회색 띠 위에 밝은 회색 글자. 글자색을 터미널 기본값에 맡기면 밝은 테마에서 배경과 구분되지 않는다.
const STATUS_BAR_BACKGROUND = "#303030";
const STATUS_BAR_FOREGROUND = "#d0d0d0";
// 위치 정보는 같은 띠 위에서 옅은 파랑(디렉터리)·초록(브랜치)으로 나머지와 구분한다.
const DIRECTORY_COLOR = "#87afd7";
const BRANCH_COLOR = "#afd787";
/** 위치 정보에 이보다 적은 칸만 남으면 위치를 빼고 오른쪽 정보만 보인다. */
const MIN_LOCATION_WIDTH = 12;

/**
 * 하단 상태 줄. 터미널 폭 전체에 배경 띠를 깔고, 왼쪽에 위치(디렉터리·브랜치), 오른쪽에 모델·모드·비용을 둔다.
 * 폭이 모자라면 디렉터리 앞부분부터 잘라 오른쪽 정보는 끝까지 남긴다.
 */
export function StatusBar({ workspace, ...params }: StatusBarProps) {
  const { stdout } = useStdout();
  const info = `  ${statusLineText(params)} `;
  const locationWidth = columnsOf(stdout) - stringWidth(info);
  if (workspace === undefined || locationWidth < MIN_LOCATION_WIDTH) {
    return (
      <Box width="100%" backgroundColor={STATUS_BAR_BACKGROUND}>
        <Text color={STATUS_BAR_FOREGROUND} wrap="truncate">{` ${statusLineText(params)}`}</Text>
      </Box>
    );
  }
  return (
    <Box width="100%" backgroundColor={STATUS_BAR_BACKGROUND}>
      <Box width={locationWidth}>
        <Text wrap="truncate-start">
          <Text color={DIRECTORY_COLOR}>{` ${workspace.directory}`}</Text>
          {workspace.branch === undefined ? null : <Text color={BRANCH_COLOR}>{`  ${workspace.branch}`}</Text>}
        </Text>
      </Box>
      <Text color={STATUS_BAR_FOREGROUND}>{info}</Text>
    </Box>
  );
}
