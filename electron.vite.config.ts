import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Os SDKs do Azure ficam fora do bundle: são pesados, trazem binários e
    // não ganham nada em ser empacotados pelo Rollup.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CommonJS, e não ESM: com `sandbox: true` o preload roda num contexto
        // restrito que não suporta `import`. Emitir .mjs aqui faz o preload
        // falhar em silêncio e `window.runbar` nunca existir no renderer.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
