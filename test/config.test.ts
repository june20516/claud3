import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/config.js";

describe("buildBaseOptions", () => {
  it("settingSources, claude_code preset, includePartialMessages, cwd, model을 설정", () => {
    const options = buildBaseOptions({ cwd: "/work", apiKey: "sk-test", model: "claude-haiku-5-5" });
    expect(options).toMatchObject({
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      cwd: "/work",
      model: "claude-haiku-5-5",
    });
  });

  it("model을 주지 않으면 옵션에 model 키가 없다 (사용자 설정의 기본 모델을 따름)", () => {
    const options = buildBaseOptions({ cwd: "/work", apiKey: "sk-test" });
    expect("model" in options).toBe(false);
  });

  it("permissionMode를 주면 옵션에 넣고, 생략하면 키가 없다", () => {
    expect(buildBaseOptions({ cwd: "/work", apiKey: "sk-test", permissionMode: "auto" }).permissionMode).toBe("auto");
    expect("permissionMode" in buildBaseOptions({ cwd: "/work", apiKey: "sk-test" })).toBe(false);
  });

  it("env.ANTHROPIC_API_KEY에 키를 넣고 process.env의 다른 값은 유지", () => {
    process.env.CLAUD3_TEST_MARKER = "kept";
    const options = buildBaseOptions({ cwd: "/work", apiKey: "sk-test" });
    expect(options.env?.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(options.env?.CLAUD3_TEST_MARKER).toBe("kept");
    delete process.env.CLAUD3_TEST_MARKER;
  });

  it("process.env 자체에는 키를 넣지 않는다", () => {
    const before = process.env.ANTHROPIC_API_KEY;
    buildBaseOptions({ cwd: "/work", apiKey: "sk-test" });
    expect(process.env.ANTHROPIC_API_KEY).toBe(before);
  });

  it("persona가 없으면 이전과 같은 옵션", () => {
    const options = buildBaseOptions({ cwd: "/work", apiKey: "sk-test" });
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect("hooks" in options).toBe(false);
  });

  it("persona가 있으면 시스템 프롬프트에 append하고 hooks를 붙인다", () => {
    const hooks = { Stop: [{ hooks: [async () => ({})] }] };
    const options = buildBaseOptions({ cwd: "/work", apiKey: "sk-test", persona: { systemAppend: "# 인격", hooks } });
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "# 인격" });
    expect(options.hooks).toBe(hooks);
  });
});
