import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_VERSION } from "./index.js";

describe("toolchain smoke", () => {
  it("resolves cross-package imports from source", () => {
    expect(CORE_PACKAGE_VERSION).toBe("0.2.0");
  });
});
