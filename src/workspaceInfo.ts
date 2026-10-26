import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 상태 줄에 보일 작업 위치. */
export interface WorkspaceInfo {
  /** 홈 아래면 ~로 줄인 현재 디렉터리. */
  directory: string;
  /** git 저장소면 현재 브랜치(detached HEAD면 짧은 커밋 해시). 아니면 없다. */
  branch?: string;
}

/** git을 cwd에서 실행하고 표준 출력을 돌려준다. 실패하면 reject한다. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const runGitCommand: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2000 });
  return stdout;
};

export function shortenDirectory(directory: string, home: string): string {
  if (directory === home) {
    return "~";
  }
  return directory.startsWith(`${home}${sep}`) ? `~${directory.slice(home.length)}` : directory;
}

async function readBranch(cwd: string, runGit: GitRunner): Promise<string | undefined> {
  try {
    return (await runGit(["symbolic-ref", "--short", "-q", "HEAD"], cwd)).trim();
  } catch {
    // 브랜치가 아니면(detached HEAD) 커밋 해시로, 그것도 안 되면 git 저장소가 아니다.
  }
  try {
    return (await runGit(["rev-parse", "--short", "HEAD"], cwd)).trim();
  } catch {
    return undefined;
  }
}

export async function readWorkspaceInfo({
  cwd,
  home = homedir(),
  runGit = runGitCommand,
}: {
  cwd: string;
  home?: string;
  runGit?: GitRunner;
}): Promise<WorkspaceInfo> {
  const directory = shortenDirectory(cwd, home);
  const branch = await readBranch(cwd, runGit);
  return branch === undefined || branch === "" ? { directory } : { directory, branch };
}

/** plain 화면용 한 줄 문구. */
export function formatLocation(info: WorkspaceInfo): string {
  return info.branch === undefined ? info.directory : `${info.directory} (${info.branch})`;
}
