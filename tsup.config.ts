import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  minify: false,
  target: 'node18',
  platform: 'node',
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.js' : '.cjs' })
});
