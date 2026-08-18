import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agent-tool-platform/runtime': resolvePath('./packages/runtime/src/index.ts'),
      '@agent-tool-platform/testkit': resolvePath('./packages/testkit/src/index.ts'),
      '@agent-tool-platform/example-minimal-capability': resolvePath(
        './examples/minimal-capability/src/index.ts',
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'examples/*/src/**/*.ts'],
      // Process entry points execute on import and are covered by the container-free CLI tests
      // rather than by unit tests that would spawn a real server on module load.
      exclude: ['packages/*/src/**/index.ts', 'packages/runtime/src/mcp/stdio-entry.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
