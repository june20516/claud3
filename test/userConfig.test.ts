import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUserConfig, resolvePermissionMode } from "../src/userConfig.js";

describe("readUserConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claud3-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(text: string): Promise<void> {
    await writeFile(join(dir, "config.json"), text, "utf8");
  }

  it("파일이 없으면 빈 설정이고 경고도 없다", async () => {
    expect(await readUserConfig(dir)).toEqual({ config: {}, warnings: [] });
  });

  it("permissionMode를 읽는다", async () => {
    await writeConfig(JSON.stringify({ permissionMode: "acceptEdits" }));
    expect(await readUserConfig(dir)).toEqual({ config: { permissionMode: "acceptEdits" }, warnings: [] });
  });

  it("알 수 없는 권한 모드는 무시하고 경고한다", async () => {
    await writeConfig(JSON.stringify({ permissionMode: "yolo" }));
    const { config, warnings } = await readUserConfig(dir);

    expect(config).toEqual({});
    expect(warnings).toEqual([
      `${join(dir, "config.json")}: 알 수 없는 권한 모드: yolo (default, acceptEdits, plan, auto)`,
    ]);
  });

  it("JSON이 깨졌거나 객체가 아니면 무시하고 경고한다", async () => {
    await writeConfig("{ 깨진");
    expect((await readUserConfig(dir)).warnings).toEqual([`${join(dir, "config.json")}: JSON 형식이 아닙니다`]);

    await writeConfig("[]");
    expect(await readUserConfig(dir)).toEqual({
      config: {},
      warnings: [`${join(dir, "config.json")}: JSON 객체가 아닙니다`],
    });
  });

  it("permissionMode가 없으면 빈 설정이다", async () => {
    await writeConfig(JSON.stringify({ other: 1 }));
    expect(await readUserConfig(dir)).toEqual({ config: {}, warnings: [] });
  });
});

describe("resolvePermissionMode", () => {
  it("실행 옵션이 설정 파일보다 우선하고, 둘 다 없으면 undefined다", () => {
    expect(resolvePermissionMode("plan", { permissionMode: "acceptEdits" })).toBe("plan");
    expect(resolvePermissionMode(undefined, { permissionMode: "acceptEdits" })).toBe("acceptEdits");
    expect(resolvePermissionMode(undefined, {})).toBeUndefined();
  });
});
