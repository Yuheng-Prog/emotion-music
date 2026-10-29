// vite.config.js
import { defineConfig } from "file:///C:/Users/Admin/Desktop/1/emotion-music/node_modules/vite/dist/node/index.js";
import vue from "file:///C:/Users/Admin/Desktop/1/emotion-music/node_modules/@vitejs/plugin-vue/dist/index.mjs";
var vite_config_default = defineConfig({
  plugins: [vue()],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      // 开发模式把后端接口转给本地 Node 服务，避免跨域
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/songs": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/models": { target: "http://127.0.0.1:8787", changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    chunkSizeWarningLimit: 2200
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxBZG1pblxcXFxEZXNrdG9wXFxcXDFcXFxcZW1vdGlvbi1tdXNpY1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcQWRtaW5cXFxcRGVza3RvcFxcXFwxXFxcXGVtb3Rpb24tbXVzaWNcXFxcdml0ZS5jb25maWcuanNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL0FkbWluL0Rlc2t0b3AvMS9lbW90aW9uLW11c2ljL3ZpdGUuY29uZmlnLmpzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSdcbmltcG9ydCB2dWUgZnJvbSAnQHZpdGVqcy9wbHVnaW4tdnVlJ1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbdnVlKCldLFxuICBiYXNlOiAnLi8nLFxuICBzZXJ2ZXI6IHtcbiAgICBwb3J0OiA1MTczLFxuICAgIHByb3h5OiB7XG4gICAgICAvLyBcdTVGMDBcdTUzRDFcdTZBMjFcdTVGMEZcdTYyOEFcdTU0MEVcdTdBRUZcdTYzQTVcdTUzRTNcdThGNkNcdTdFRDlcdTY3MkNcdTU3MzAgTm9kZSBcdTY3MERcdTUyQTFcdUZGMENcdTkwN0ZcdTUxNERcdThERThcdTU3REZcbiAgICAgICcvYXBpJzogeyB0YXJnZXQ6ICdodHRwOi8vMTI3LjAuMC4xOjg3ODcnLCBjaGFuZ2VPcmlnaW46IHRydWUgfSxcbiAgICAgICcvc29uZ3MnOiB7IHRhcmdldDogJ2h0dHA6Ly8xMjcuMC4wLjE6ODc4NycsIGNoYW5nZU9yaWdpbjogdHJ1ZSB9LFxuICAgICAgJy9tb2RlbHMnOiB7IHRhcmdldDogJ2h0dHA6Ly8xMjcuMC4wLjE6ODc4NycsIGNoYW5nZU9yaWdpbjogdHJ1ZSB9XG4gICAgfVxuICB9LFxuICBidWlsZDoge1xuICAgIG91dERpcjogJ2Rpc3QnLFxuICAgIGFzc2V0c0RpcjogJ2Fzc2V0cycsXG4gICAgY2h1bmtTaXplV2FybmluZ0xpbWl0OiAyMjAwXG4gIH1cbn0pXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWdULFNBQVMsb0JBQW9CO0FBQzdVLE9BQU8sU0FBUztBQUVoQixJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTLENBQUMsSUFBSSxDQUFDO0FBQUEsRUFDZixNQUFNO0FBQUEsRUFDTixRQUFRO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUE7QUFBQSxNQUVMLFFBQVEsRUFBRSxRQUFRLHlCQUF5QixjQUFjLEtBQUs7QUFBQSxNQUM5RCxVQUFVLEVBQUUsUUFBUSx5QkFBeUIsY0FBYyxLQUFLO0FBQUEsTUFDaEUsV0FBVyxFQUFFLFFBQVEseUJBQXlCLGNBQWMsS0FBSztBQUFBLElBQ25FO0FBQUEsRUFDRjtBQUFBLEVBQ0EsT0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsV0FBVztBQUFBLElBQ1gsdUJBQXVCO0FBQUEsRUFDekI7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
