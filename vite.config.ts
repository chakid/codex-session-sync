import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

export default defineConfig({
  plugins: [
    vue(),
    Components({
      dts: "components.d.ts",
      resolvers: [ElementPlusResolver({ importStyle: "css" })]
    })
  ],
  root: "frontend",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4588",
        changeOrigin: false
      }
    }
  }
});
