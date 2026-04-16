import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 2222,
    fs: { strict: false },
  },
  assetsInclude: ["**/*.glb"],
});
