import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests always run against package sources so `npm test` never depends on a
    // prior `tsc -b`. Published resolution still goes through dist/ exports.
    alias: {
      "@ytriple/shared": fromRoot("./packages/shared/src/index.ts"),
      "@ytriple/providers": fromRoot("./packages/providers/src/index.ts"),
      "@ytriple/core": fromRoot("./packages/core/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    restoreMocks: true,
  },
});
