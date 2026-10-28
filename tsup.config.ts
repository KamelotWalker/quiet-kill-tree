import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  minify: false,
  // Minify the bundles to keep the tarball small. `keepNames` preserves
  // function and class names, so stack traces still say which function failed.
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: true,
  keepNames: true,
  target: 'node18',
  platform: 'node',
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.js' : '.cjs' })
});
