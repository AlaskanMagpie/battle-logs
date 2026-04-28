import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        mapEditor: "map-editor.html",
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/examples")) return "three-extras";
          if (id.includes("node_modules/three")) return "three-core";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
        },
      },
    },
  },
  server: {
    /** Local-only dev (see `npm run dev:lan` for 0.0.0.0 / phone on Wi‑Fi). */
    host: "localhost",
    port: 2222,
    /** Prefer 2222; if another process holds it, Vite picks the next free port instead of exiting. */
    strictPort: false,
    fs: { strict: false },
  },
  preview: {
    host: "localhost",
    port: 2222,
    strictPort: false,
  },
  assetsInclude: ["**/*.glb"],
});
