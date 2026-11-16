import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  // 상대 경로로 빌드: 루트(Cloudflare Pages)와 하위 경로(GitHub Pages /last-ember/) 양쪽에서 동작
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:8787' },
  },
});
