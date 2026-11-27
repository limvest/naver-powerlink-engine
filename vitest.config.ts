import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'programs/**/tests/**/*.test.ts'],
    testTimeout: 60000,
    // Each test file starts its own PGlite (WASM) instance, so cap workers and allow slow hooks.
    hookTimeout: 60000,
    maxWorkers: 3,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
