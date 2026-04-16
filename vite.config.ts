import { defineConfig } from "vite";

export default defineConfig({
  server: {
    /* true: desktop still uses http://localhost:2222/; phone on same LAN uses http://<this-pc-ip>:2222/ */
    host: true,
    port: 2222,
    strictPort: true,
    fs: { strict: false },
  },
  preview: {
    host: true,
    port: 2222,
    strictPort: true,
  },
  assetsInclude: ["**/*.glb"],
});
