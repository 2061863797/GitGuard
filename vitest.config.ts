import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'tests/**/*.spec.ts'
    ],
    exclude: [
      'node_modules',
      'dist',
      '.agents'
    ],
    testTimeout: 35000,
    hookTimeout: 35000,
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        '**/*.d.ts'
      ]
    }
  }
});
