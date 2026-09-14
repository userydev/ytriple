import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves this build as the renderer. The dev server is also how the UI is
// exercised in a browser against the demo host, which needs no Rust toolchain.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
});
