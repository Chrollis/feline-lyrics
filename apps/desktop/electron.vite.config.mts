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
      // electron-vite reads preload entries from `rolldownOptions.input`, unlike
      // the main build; giving the startup window its own preload keeps
      // `window.felyrics` absent from a page that only reports status.
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/preload/index.ts'),
          bootstrap: resolve(import.meta.dirname, 'src/preload/bootstrap.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          bootstrap: resolve(import.meta.dirname, 'src/renderer/bootstrap.html'),
        },
      },
    },
  },
});
