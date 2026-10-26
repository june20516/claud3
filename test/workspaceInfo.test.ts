import { describe, expect, it, vi } from "vitest";
import { formatLocation, readWorkspaceInfo, shortenDirectory } from "../src/workspaceInfo.js";
import type { GitRunner } from "../src/workspaceInfo.js";

describe("shortenDirectory", () => {
  it("홈 디렉터리 아래는 ~로 줄이고, 홈 자체는 ~다", () => {
    expect(shortenDirectory("/Users/me/personal/claud3", "/Users/me")).toBe("~/personal/claud3");
    expect(shortenDirectory("/Users/me", "/Users/me")).toBe("~");
  });

  it("이름이 홈으로 시작할 뿐인 다른 디렉터리나 홈 밖은 그대로 둔다", () => {
    expect(shortenDirectory("/Users/meow/x", "/Users/me")).toBe("/Users/meow/x");
    expect(shortenDirectory("/tmp/work", "/Users/me")).toBe("/tmp/work");
  });
});

describe("readWorkspaceInfo", () => {
  it("git 저장소면 현재 브랜치를 읽는다", async () => {
    const runGit = vi.fn<GitRunner>(async () => "feat/x\n");

    await expect(readWorkspaceInfo({ cwd: "/Users/me/repo", home: "/Users/me", runGit })).resolves.toEqual({
      directory: "~/repo",
      branch: "feat/x",
    });
    expect(runGit).toHaveBeenCalledWith(["symbolic-ref", "--short", "-q", "HEAD"], "/Users/me/repo");
  });

  it("detached HEAD면 짧은 커밋 해시를 쓴다", async () => {
    const runGit: GitRunner = async (args) => {
      if (args[0] === "symbolic-ref") {
        throw new Error("not a symbolic ref");
      }
      return "3a5d8ed\n";
    };

    await expect(readWorkspaceInfo({ cwd: "/r", home: "/Users/me", runGit })).resolves.toEqual({
      directory: "/r",
      branch: "3a5d8ed",
    });
  });

  it("git 저장소가 아니거나 git이 없으면 브랜치 없이 디렉터리만", async () => {
    const runGit: GitRunner = async () => {
      throw new Error("not a git repository");
    };

    await expect(readWorkspaceInfo({ cwd: "/tmp/x", home: "/Users/me", runGit })).resolves.toEqual({ directory: "/tmp/x" });
  });
});

describe("formatLocation", () => {
  it("디렉터리와 브랜치를 함께, 브랜치가 없으면 디렉터리만", () => {
    expect(formatLocation({ directory: "~/repo", branch: "main" })).toBe("~/repo (main)");
    expect(formatLocation({ directory: "/tmp/x" })).toBe("/tmp/x");
  });
});
