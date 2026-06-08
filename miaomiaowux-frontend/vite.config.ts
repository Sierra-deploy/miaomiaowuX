import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import bundleObfuscator from 'vite-plugin-bundle-obfuscator'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    // 生产构建混淆 — 中等强度配置:hex 标识符 + 控制流扁平化 + 字符串数组 base64。
    // 反向工程门槛从"零成本看源码"提升到"需要专业混淆还原工具 + 几小时"。
    // 不开 selfDefending / debugProtection / disableConsoleOutput,避免影响真实用户排错与 React 渲染。
    bundleObfuscator({
      excludes: [],
      enable: true,
      log: false,
      autoExcludeNodeModules: true,
      threadPool: { enable: true, size: 4 },
      apply: 'build',
      options: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.6,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.3,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        transformObjectKeys: true,
        unicodeEscapeSequence: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../internal/web/dist'),
    emptyOutDir: true,
    // 关 sourcemap — 不再随产物公开 .map 文件,等同于无混淆
    sourcemap: false,
  },
  css: {
    devSourcemap: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:12889',
      },
      // 临时订阅路径代理到后端（仅开发环境生效）
      '/t/': {
        target: process.env.VITE_API_URL || 'http://localhost:12889',
        changeOrigin: true,
      },
      '/x/': {
        target: process.env.VITE_API_URL || 'http://localhost:12889',
        changeOrigin: true,
      },
    },
  },
})
