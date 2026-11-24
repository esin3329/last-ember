import { defineConfig } from 'vite';
import { pwa } from './scripts/vite-pwa.ts';

export default defineConfig({
  root: 'client',
  // 상대 경로로 빌드: 루트(Cloudflare Pages)와 하위 경로(GitHub Pages /last-ember/) 양쪽에서 동작
  base: './',
  plugins: [pwa()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    fs: { allow: ['..'] },
    // 프록시를 거쳐도 개발 서버의 원래 Host를 유지한다.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
});
