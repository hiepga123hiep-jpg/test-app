import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const runtimeAssets = [
  'app.js',
  'supabase-config.js',
  'album_aurora.jpg',
  'album_jazz.jpg',
  'album_lofi.jpg',
  'album_lumina.jpg',
  'album_nova.jpg',
];

export default defineConfig({
  base: './',
  plugins: [{
    name: 'spotisix-runtime-assets',
    apply: 'build',
    async generateBundle() {
      for (const fileName of runtimeAssets) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(resolve(process.cwd(), fileName)),
        });
      }
    },
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
