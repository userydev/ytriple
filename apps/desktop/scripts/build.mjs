import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
// Use the same source as the packaged .icns so a stale macOS Dock cache
// cannot keep displaying a previous product icon while the app is running.
const dockIcon = new Resvg(await readFile("../../assets/app-icon.svg"), {
  fitTo: { mode: "width", value: 512 },
})
  .render()
  .asPng();
await build({
  define: {
    __YTRIPLE_MEMBER_TEMPLATE_LICENSE__: JSON.stringify(await readFile("src/assets/licenses/agency-agents-MIT.license", "utf8")),
    __YTRIPLE_DOCK_ICON__: JSON.stringify(
      `data:image/png;base64,${dockIcon.toString("base64")}`,
    ),
  },
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
