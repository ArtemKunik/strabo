import { defineConfig } from 'vite';

// Object-form aliases; values use both config-relative and root-absolute styles.
export default defineConfig({
  resolve: {
    alias: {
      '@ui': './src/components',
      '~store': '/src/lib/store.ts',
    },
  },
});
