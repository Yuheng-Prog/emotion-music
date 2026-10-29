import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      // 开发模式把后端接口转给本地 Node 服务，避免跨域
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/songs': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/models': { target: 'http://127.0.0.1:8787', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 2200
  }
})
