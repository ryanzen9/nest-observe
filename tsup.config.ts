import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/register.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node20',
  external: ['@nestjs/common', '@nestjs/core', 'reflect-metadata', 'rxjs'],
});
