import { build } from "esbuild";
import { build as viteBuild } from "vite";
await build({
  entryPoints: ["src/main/main.ts", "src/main/preload.ts"],
  outdir: "build",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "node:sqlite"],
  sourcemap: true,
});
await viteBuild({
  root: "src/ui",
  base: "./",
  build: { outDir: "../../out", emptyOutDir: true },
});
