import { describe, expect, it, vi } from "vitest";
import { MissingApiKeyError, readApiKey } from "../src/auth.js";

describe("readApiKey", () => {
  it("키체인 값을 앞뒤 공백·줄바꿈 제거해 반환", async () => {
    expect(await readApiKey(async () => ({ exitCode: 0, stdout: "sk-ant-x\n" }))).toBe("sk-ant-x");
  });

  it("security에 정확한 인자를 넘긴다", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "k" }));
    await readApiKey(run);
    expect(run).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "anthropic-api", "-w"]);
  });

  it("종료 코드가 0이 아니면 MissingApiKeyError", async () => {
    await expect(readApiKey(async () => ({ exitCode: 44, stdout: "" }))).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("빈 값이면 MissingApiKeyError", async () => {
    await expect(readApiKey(async () => ({ exitCode: 0, stdout: "  \n" }))).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("MissingApiKeyError 메시지에 등록 명령을 포함", () => {
    expect(new MissingApiKeyError().message).toContain('security add-generic-password -a "$USER" -s anthropic-api -w');
  });
});
