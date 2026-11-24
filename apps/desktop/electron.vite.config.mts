import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Two entries, one process each: the app's main process and the plugin
        // host it forks per plugin. They share the build so a change to either
        // rebuilds both.
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          utility: resolve(import.meta.dirname, 'src/utility/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
