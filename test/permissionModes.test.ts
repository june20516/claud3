import { describe, expect, it } from "vitest";
import {
  describePermissionMode,
  nextPermissionMode,
  parsePermissionMode,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODES,
  unknownPermissionModeMessage,
} from "../src/permissionModes.js";

describe("permissionModes", () => {
  it("노출 모드는 default, acceptEdits, plan, auto 순서다", () => {
    expect(PERMISSION_MODES).toEqual(["default", "acceptEdits", "plan", "auto"]);
  });

  it("모드별 설명 문구가 고정되어 있다", () => {
    expect(PERMISSION_MODE_DESCRIPTIONS).toEqual({
      default: "위험한 도구는 매번 묻기",
      acceptEdits: "파일 편집은 묻지 않고 허용",
      plan: "계획만 세우고 도구 실행 안 함",
      auto: "분류기가 판단, 애매하면 묻기",
    });
  });

  describe("parsePermissionMode", () => {
    it.each(["default", "acceptEdits", "plan", "auto"] as const)("%s를 그대로 반환한다", (mode) => {
      expect(parsePermissionMode(mode)).toBe(mode);
    });

    it.each(["Plan", "bypassPermissions", "", " plan", "dontAsk"])("%j는 undefined를 반환한다", (text) => {
      expect(parsePermissionMode(text)).toBeUndefined();
    });
  });

  describe("nextPermissionMode", () => {
    it("목록 순서대로 다음 모드를 반환하고 마지막은 처음으로 돌아간다", () => {
      expect(nextPermissionMode("default")).toBe("acceptEdits");
      expect(nextPermissionMode("acceptEdits")).toBe("plan");
      expect(nextPermissionMode("plan")).toBe("auto");
      expect(nextPermissionMode("auto")).toBe("default");
    });

    it("현재 모드가 없으면 default로 보고 다음인 acceptEdits를 반환한다", () => {
      expect(nextPermissionMode(undefined)).toBe("acceptEdits");
    });

    it("목록 밖 모드는 default를 반환한다", () => {
      expect(nextPermissionMode("dontAsk")).toBe("default");
      expect(nextPermissionMode("bypassPermissions")).toBe("default");
    });
  });

  describe("describePermissionMode", () => {
    it("목록 안 모드는 이름과 설명을 함께 반환한다", () => {
      expect(describePermissionMode("plan")).toBe("plan — 계획만 세우고 도구 실행 안 함");
    });

    it("목록 밖 모드는 이름만 반환한다", () => {
      expect(describePermissionMode("dontAsk")).toBe("dontAsk");
    });
  });

  describe("unknownPermissionModeMessage", () => {
    it("잘못된 이름 안내 문구를 만든다", () => {
      expect(unknownPermissionModeMessage("x")).toBe("알 수 없는 권한 모드: x (default, acceptEdits, plan, auto)");
    });
  });
});
