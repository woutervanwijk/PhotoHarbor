import { defineConfig } from "vite";

export default defineConfig({
  // Suppress Vite's own terminal clear so Tauri's output stays visible.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    // Tell Vite to watch the src-tauri dir so a Rust rebuild triggers a page reload.
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },

  build: {
    // Tauri's CSP requires no inline scripts in production.
    outDir: "dist",
    emptyOutDir: true,
  },
});
