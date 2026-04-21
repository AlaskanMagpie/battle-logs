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
    },
  },
  server: {
    /* true: desktop still uses http://localhost:2222/; phone on same LAN uses http://<this-pc-ip>:2222/ */
    host: true,
    port: 2222,
    /** Prefer 2222; if another process holds it, Vite picks the next free port instead of exiting. */
    strictPort: false,
    fs: { strict: false },
  },
  preview: {
    host: true,
    port: 2222,
    strictPort: false,
  },
  assetsInclude: ["**/*.glb"],
});
