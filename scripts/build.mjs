import { build } from "esbuild";
import { build as viteBuild } from "vite";
await build({
  entryPoints: { main: "src/desktop/main.ts", worker: "src/desktop/worker.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outdir: "dist",
  sourcemap: true,
  target: "node24",
});
await build({
  entryPoints: ["src/desktop/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/preload.cjs",
  target: "node24",
});
await viteBuild();
